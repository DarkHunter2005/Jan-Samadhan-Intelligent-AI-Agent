"""Train the grievance category + priority models and persist them to models/.

Usage:
    python train.py                # train with defaults
    python train.py --n 600        # bigger synthetic corpus
    python train.py --model rf     # RandomForest instead of LogisticRegression

Artefacts written to ml-service/models/:
    category_model.joblib   TF-IDF (word+char) -> LinearSVC/LogReg/RF, calibrated
    priority_model.joblib   TF-IDF + lexicon features -> LogisticRegression (P(high))
    metrics.json            evaluation report used by /health and the docs
"""

from __future__ import annotations

import argparse
import json
import pathlib
import time

import numpy as np
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import RandomForestClassifier
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    classification_report,
    f1_score,
    roc_auc_score,
)
from sklearn.model_selection import cross_val_score, train_test_split
from sklearn.pipeline import FeatureUnion, Pipeline
from sklearn.preprocessing import FunctionTransformer
from sklearn.svm import LinearSVC

from app.dataset import generate
from app.features import LexiconFeatures, normalize_batch
from app.taxonomy import CATEGORY_KEYS

ROOT = pathlib.Path(__file__).resolve().parent
MODEL_DIR = ROOT / "models"
DATA_DIR = ROOT / "data"


def text_normalizer():
    """Picklable preprocessing step (references a module-level function, not a lambda)."""
    return FunctionTransformer(normalize_batch, validate=False)


def build_category_pipeline(kind: str) -> Pipeline:
    """TF-IDF word + char n-grams -> classifier, wrapped for probability output."""
    vectorizer = FeatureUnion(
        [
            ("word", TfidfVectorizer(ngram_range=(1, 2), min_df=2, sublinear_tf=True,
                                     max_features=60000)),
            ("char", TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), min_df=3,
                                     sublinear_tf=True, max_features=60000)),
        ]
    )

    if kind == "rf":
        clf = RandomForestClassifier(n_estimators=300, min_samples_leaf=2,
                                     n_jobs=-1, random_state=42)
    elif kind == "svm":
        clf = CalibratedClassifierCV(LinearSVC(C=1.0), cv=3, method="sigmoid")
    else:  # logreg (default)
        clf = LogisticRegression(C=6.0, max_iter=2000, n_jobs=-1, multi_class="auto")

    return Pipeline([("norm", text_normalizer()), ("tfidf", vectorizer), ("clf", clf)])


def build_priority_pipeline() -> Pipeline:
    """TF-IDF + hand-crafted lexicon features -> binary P(high priority)."""
    union = FeatureUnion(
        [
            ("tfidf", Pipeline([
                ("norm", text_normalizer()),
                ("vec", TfidfVectorizer(ngram_range=(1, 2), min_df=2, sublinear_tf=True,
                                        max_features=40000)),
            ])),
            ("lexicon", LexiconFeatures()),
        ]
    )
    return Pipeline([
        ("features", union),
        ("clf", LogisticRegression(C=3.0, max_iter=2000, class_weight="balanced")),
    ])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--n", type=int, default=420, help="rows per category")
    parser.add_argument("--model", default="logreg", choices=["logreg", "svm", "rf"])
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    MODEL_DIR.mkdir(exist_ok=True)
    DATA_DIR.mkdir(exist_ok=True)

    t0 = time.time()
    rows = generate(n_per_category=args.n, seed=args.seed)
    texts = [r["text"] for r in rows]
    y_cat = [r["category"] for r in rows]
    # A complaint is "high priority" ground truth when it is severe, or urgent while
    # also being repeatedly ignored.
    y_pri = [
        int(r["severity_flag"] or (r["urgency_flag"] and r["frequency_flag"]))
        for r in rows
    ]

    print(f"corpus: {len(rows)} rows, {len(set(y_cat))} categories, "
          f"{sum(y_pri)} high-priority ({sum(y_pri)/len(y_pri):.1%})")

    # ---------------- category model ----------------
    Xtr, Xte, ytr, yte = train_test_split(
        texts, y_cat, test_size=0.2, random_state=args.seed, stratify=y_cat
    )
    cat_pipe = build_category_pipeline(args.model)
    cat_pipe.fit(Xtr, ytr)
    pred = cat_pipe.predict(Xte)
    cat_acc = accuracy_score(yte, pred)
    cat_f1 = f1_score(yte, pred, average="macro")
    print(f"\ncategory model ({args.model}): acc={cat_acc:.4f} macro-f1={cat_f1:.4f}")
    print(classification_report(yte, pred, digits=3))

    cv = cross_val_score(build_category_pipeline(args.model), texts, y_cat,
                         cv=3, scoring="accuracy", n_jobs=1)
    print(f"3-fold CV accuracy: {cv.mean():.4f} (+/- {cv.std():.4f})")

    # ---------------- priority model ----------------
    Ptr, Pte, ptr, pte = train_test_split(
        texts, y_pri, test_size=0.2, random_state=args.seed, stratify=y_pri
    )
    pri_pipe = build_priority_pipeline()
    pri_pipe.fit(Ptr, ptr)
    pprob = pri_pipe.predict_proba(Pte)[:, 1]
    ppred = (pprob >= 0.5).astype(int)
    pri_acc = accuracy_score(pte, ppred)
    pri_auc = roc_auc_score(pte, pprob)
    pri_f1 = f1_score(pte, ppred)
    print(f"\npriority model: acc={pri_acc:.4f} f1={pri_f1:.4f} roc_auc={pri_auc:.4f}")
    print(classification_report(pte, ppred, digits=3))

    # ---------------- persist ----------------
    import joblib

    joblib.dump({"pipeline": cat_pipe, "classes": list(cat_pipe.classes_), "kind": args.model},
                MODEL_DIR / "category_model.joblib", compress=3)
    joblib.dump({"pipeline": pri_pipe}, MODEL_DIR / "priority_model.joblib", compress=3)

    metrics = {
        "trained_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "train_seconds": round(time.time() - t0, 2),
        "corpus_size": len(rows),
        "categories": CATEGORY_KEYS,
        "category_model": {
            "kind": args.model,
            "accuracy": round(float(cat_acc), 4),
            "macro_f1": round(float(cat_f1), 4),
            "cv_accuracy_mean": round(float(cv.mean()), 4),
            "cv_accuracy_std": round(float(cv.std()), 4),
            "report": classification_report(yte, pred, output_dict=True, zero_division=0),
        },
        "priority_model": {
            "accuracy": round(float(pri_acc), 4),
            "f1": round(float(pri_f1), 4),
            "roc_auc": round(float(pri_auc), 4),
        },
    }
    (MODEL_DIR / "metrics.json").write_text(json.dumps(metrics, indent=2))

    # Also dump the corpus for inspection / reproducibility.
    import csv
    with (DATA_DIR / "grievances.csv").open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)

    print(f"\nsaved models -> {MODEL_DIR} in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
