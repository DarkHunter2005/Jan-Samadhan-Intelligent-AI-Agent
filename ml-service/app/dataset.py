"""Synthetic training-corpus generator for the grievance classifier.

Real grievance corpora (CPGRAMS/PGRS exports) are not redistributable, so this module
builds a template-driven corpus that mirrors how citizens actually write: short, noisy,
code-mixed English/Hindi/Malayalam transliteration, with urgency and repetition cues.

Every generated row carries:
    text, category, urgency_flag, frequency_flag, severity_flag
so the same corpus trains both the category model and the priority model.
"""

from __future__ import annotations

import random

from .taxonomy import CATEGORY_KEYS

# Each category: (core templates, slot fillers)
TEMPLATES: dict[str, list[str]] = {
    "water_supply": [
        "No water supply in {place} for {duration}",
        "Drinking water not coming to our {place} since {duration}",
        "Water pipe burst near {place}, water flowing wastefully on road",
        "Muddy and contaminated water coming from tap in {place}",
        "Water tanker did not arrive at {place} as promised",
        "Very low pressure water supply in {place}, cannot fill even one pot",
        "Public tap in {place} is broken and leaking continuously",
        "Water bill charged wrongly, meter reading not taken in {place}",
        "Well water in {place} smells bad, suspect sewage mixing",
        "Water connection application pending for {duration} in {place}",
        "Vellam varunnilla {place} il, {duration} ayi",
        "Paani nahi aa raha hai {place} me {duration} se",
    ],
    "electricity": [
        "Power cut in {place} since {duration}, no restoration yet",
        "Street light not working near {place} for {duration}",
        "Live electric wire hanging low over road at {place}, very dangerous",
        "Transformer at {place} making loud noise and sparking",
        "Frequent voltage fluctuation in {place} damaged our appliances",
        "Electricity bill amount is abnormally high this month in {place}",
        "New electricity connection application pending {duration} at {place}",
        "Electric post leaning dangerously near {place}",
        "Meter not working, estimated bill issued in {place}",
        "Power failure in {place} affecting water pump and borewell",
        "Current illa {place} il {duration} ayi",
        "Bijli nahi hai {place} me {duration} se",
    ],
    "roads_transport": [
        "Large pothole on main road at {place} causing accidents",
        "Road at {place} completely damaged after rain, not motorable",
        "No street lighting and broken road at {place}, unsafe at night",
        "Road work at {place} left incomplete for {duration}",
        "Drainage side wall of road at {place} collapsed",
        "Speed breaker needed near school at {place}, vehicles overspeeding",
        "Bridge approach road at {place} has deep cracks",
        "Bus stop shelter at {place} is broken and unusable",
        "Illegal parking blocking road at {place} daily",
        "Footpath at {place} encroached, pedestrians forced on road",
        "Road kuzhi {place} il, vandi pokan pattunnilla",
        "Sadak kharab hai {place} me {duration} se",
    ],
    "sanitation_waste": [
        "Garbage not collected from {place} for {duration}",
        "Waste dumped illegally near {place}, terrible smell",
        "Drainage blocked at {place}, sewage overflowing on street",
        "Public toilet at {place} is filthy and unusable",
        "Stagnant water at {place} breeding mosquitoes, dengue risk",
        "Dead animal lying near {place} for {duration}, not removed",
        "Septic tank overflow at {place} contaminating well water",
        "Open defecation near {place} due to lack of facilities",
        "Plastic waste burning at {place} causing air pollution",
        "Canal at {place} filled with waste, water not flowing",
        "Waste eduthittilla {place} il {duration} ayi",
        "Kachra nahi uthaya {place} se {duration} se",
    ],
    "health_medical": [
        "No doctor available at PHC in {place} during duty hours",
        "Medicines out of stock at government hospital in {place}",
        "Ambulance not available at {place} during emergency",
        "Hospital staff at {place} behaved rudely with patient",
        "Dengue and fever cases increasing rapidly in {place}",
        "Vaccination camp not conducted in {place} as scheduled",
        "Hospital ward in {place} is unhygienic, no cleaning",
        "Pregnant woman denied admission at hospital in {place}",
        "Lab test reports delayed for {duration} at hospital in {place}",
        "Dialysis unit at {place} not functioning for {duration}",
        "Doctor illa {place} le aashupathriyil",
        "Dawai nahi mil rahi {place} ke aspatal me",
    ],
    "police_safety": [
        "FIR not registered at police station in {place} despite complaint",
        "Anti social elements gathering near {place} at night, drinking",
        "Repeated theft incidents reported in {place}, no patrolling",
        "Eve teasing near bus stop at {place}, girls feel unsafe",
        "Loud noise and illegal party at {place} disturbing residents",
        "Threat received from neighbour in {place}, police not responding",
        "Drug sale suspected near school at {place}",
        "Domestic violence case in {place} not acted upon",
        "Cyber fraud money lost, police station at {place} not accepting complaint",
        "Illegal liquor sale at {place} continuing openly",
        "Police case edukkunnilla {place} il",
        "Chori ho rahi hai {place} me baar baar",
    ],
    "education": [
        "Teacher shortage at government school in {place} for {duration}",
        "School building at {place} has leaking roof, unsafe for children",
        "Midday meal quality is very poor at school in {place}",
        "Toilet facility not available for girls at school in {place}",
        "Textbooks not distributed at school in {place} even after {duration}",
        "School bus service discontinued in {place} without notice",
        "Scholarship amount not credited for students in {place}",
        "Private school in {place} charging excess fees illegally",
        "Computer lab at school in {place} non functional for {duration}",
        "Drinking water facility absent at school in {place}",
        "School il teacher illa {place}",
        "School ki chhat tapak rahi hai {place} me",
    ],
    "revenue_certificates": [
        "Income certificate application pending for {duration} at village office {place}",
        "Caste certificate rejected without reason at {place}",
        "Land tax payment not updated in records at {place}",
        "Possession certificate delayed {duration} at village office in {place}",
        "Survey of property at {place} not conducted despite application",
        "Mutation of land records pending for {duration} in {place}",
        "Village officer at {place} demanding unnecessary documents",
        "Ration card correction application pending {duration} in {place}",
        "Encumbrance certificate not issued at {place} sub registrar office",
        "Boundary dispute survey request ignored at {place}",
        "Certificate kittunnilla {place} village office il {duration} ayi",
        "Praman patra nahi mila {place} me {duration} se",
    ],
    "welfare_pension": [
        "Old age pension not credited for {duration} in {place}",
        "Widow pension application pending at {place} for {duration}",
        "Disability pension stopped without intimation in {place}",
        "Ration not distributed properly at fair price shop in {place}",
        "Housing scheme benefit not received in {place} despite approval",
        "Unemployment allowance application rejected wrongly at {place}",
        "Anganwadi in {place} not providing nutrition supplement",
        "Welfare fund amount delayed for workers in {place}",
        "Pension amount reduced without any notice in {place}",
        "Beneficiary list for scheme in {place} excludes eligible families",
        "Pension kittiyittilla {duration} ayi {place} il",
        "Pension nahi aayi {duration} se {place} me",
    ],
    "municipal_admin": [
        "Building permit application pending at municipality in {place} for {duration}",
        "Birth certificate correction not done at {place} office",
        "Property tax receipt not issued at {place} municipal office",
        "Stray dog menace increasing near {place}, attacks reported",
        "Illegal construction going on at {place} without permit",
        "Trade licence renewal delayed for {duration} at {place}",
        "Park at {place} not maintained, equipment broken",
        "Marriage certificate registration delayed at {place}",
        "Encroachment of public land at {place} not removed",
        "Municipal office at {place} staff absent during working hours",
        "Municipality office il file move aakunnilla {place}",
        "Nagar palika me kaam nahi ho raha {place} me",
    ],
    "corruption_bribery": [
        "Officer at {place} demanded bribe to clear my file",
        "Money demanded for issuing certificate at {place} office",
        "Contractor and engineer colluding in road work at {place}",
        "Substandard material used in government work at {place}",
        "Clerk at {place} asking commission to process pension",
        "Tender for work at {place} awarded without proper process",
        "Fund allotted for {place} project misused, work not done",
        "Staff at {place} favouring relatives in beneficiary list",
        "Bribe demanded for building permit at {place}",
        "Fake bills submitted for work at {place}",
        "Kaikkooli chodhichu {place} office il",
        "Rishwat maang rahe hai {place} me",
    ],
    "transport_rto": [
        "Driving licence application pending for {duration} at RTO {place}",
        "Vehicle registration certificate not received after {duration} in {place}",
        "Private buses overcharging on route through {place}",
        "Autorickshaw drivers refusing meter at {place}",
        "Bus not stopping at designated stop in {place}",
        "Learner licence test slot not available at {place} for {duration}",
        "Vehicle fitness certificate process delayed at {place}",
        "Overloaded tipper lorries speeding through {place}",
        "Bus service on {place} route cancelled without notice",
        "Ownership transfer of vehicle pending {duration} at {place}",
        "Licence kittunnilla RTO {place} il",
        "Bus wale zyada paisa le rahe hai {place} me",
    ],
}

PLACES = [
    "Erattupetta", "Ward 7 Erattupetta", "Poonjar", "Teekoy", "Kanjirappally", "Palai",
    "Ettumanoor", "Kottayam town", "Changanassery", "Vaikom", "Pampady", "Melukavu",
    "Bharananganam", "Ramapuram", "Thodupuzha", "Muvattupuzha", "Adimali", "Kattappana",
    "Aluva", "Perumbavoor", "Kalamassery", "Thrippunithura", "Vyttila", "Kakkanad",
    "Ward 3 colony", "MG road area", "Market junction", "Panchayat ward 11",
    "Hospital junction", "School road", "Temple road", "Church junction", "Bus stand area",
]

DURATIONS = [
    "3 days", "one week", "two weeks", "10 days", "one month", "two months",
    "three months", "six months", "45 days", "more than a year", "5 days", "4 days",
]

URGENCY_PREFIXES = [
    "Urgent: ", "URGENT - ", "Immediate action needed. ", "Emergency! ",
    "Please act immediately. ", "This is critical. ", "Turant dhyan dein. ",
    "Adiyanthiramayi nadapadi venam. ",
]

FREQUENCY_SUFFIXES = [
    " I have complained about this three times already, no action taken.",
    " This is my repeated complaint, previous complaint was ignored.",
    " Same problem happening again and again every week.",
    " No response received to my earlier complaints.",
    " Reminder: raised this issue last month also, still not resolved.",
    " Veendum veendum same problem, aarum nokkunnilla.",
    " Baar baar shikayat ki, koi action nahi.",
]

SEVERITY_SUFFIXES = {
    "water_supply": [
        " Water is contaminated and two children fell sick after drinking it.",
        " Elderly patients in the area have no drinking water at all.",
        " Hospital in the area is also affected by this shortage.",
    ],
    "electricity": [
        " A live wire is touching the ground, high risk of electrocution.",
        " Sparks caused a small fire near the house, could be fatal.",
        " A person was injured when the electric post fell down.",
    ],
    "roads_transport": [
        " Two accidents already happened here, one person was seriously injured.",
        " A schoolchild fell into the pothole and got injured yesterday.",
        " The retaining wall may collapse on houses below any moment.",
    ],
    "sanitation_waste": [
        " Dengue outbreak reported, three people hospitalised already.",
        " Sewage entered our drinking water well, family is falling sick.",
        " Rats and stray dogs are spreading disease, a child was bitten.",
    ],
    "health_medical": [
        " A patient died waiting for treatment because no doctor was present.",
        " Pregnant woman in critical condition was refused admission.",
        " Accident victim was left bleeding without any first aid.",
    ],
    "police_safety": [
        " I have received death threats and fear for my family's safety.",
        " A woman was assaulted near this spot last night.",
        " Minor girl was harassed, situation is dangerous.",
    ],
    "education": [
        " Part of the classroom ceiling fell down, children narrowly escaped.",
        " Students got food poisoning after the midday meal.",
        " Compound wall is collapsing where children play.",
    ],
    "revenue_certificates": [
        " Because of this delay my daughter is losing her college admission.",
        " Medical treatment loan is stuck due to missing certificate.",
        " I am losing my job offer because of this pending document.",
    ],
    "welfare_pension": [
        " I am bedridden and have no other income for food or medicine.",
        " Family has no money for the patient's dialysis treatment.",
        " Unable to buy essential medicines for the last two months.",
    ],
    "municipal_admin": [
        " Stray dogs attacked two children in the last week here.",
        " The illegal construction is destabilising the neighbouring house.",
        " Unsafe building may collapse on the public road.",
    ],
    "corruption_bribery": [
        " I have recorded evidence of the bribe demand and I fear retaliation.",
        " The substandard work is a public safety risk for the whole ward.",
        " Threats were made when I refused to pay the bribe.",
    ],
    "transport_rto": [
        " Overloaded lorries nearly hit schoolchildren twice this week.",
        " The unsafe bus caused an accident injuring two passengers.",
        " Drunk driving by the route bus driver endangers all passengers.",
    ],
}

POLITE_PREFIXES = [
    "Sir, ", "Respected sir, ", "Madam, ", "To the concerned officer, ",
    "Kindly note that ", "I would like to report that ", "Complaint: ", "",
    "Please look into this. ", "Sir/Madam, ",
]

POLITE_SUFFIXES = [
    " Kindly take necessary action.", " Please resolve at the earliest.",
    " Requesting your intervention.", " Hoping for a quick solution.",
    " Thanking you.", "", " Please do the needful.",
]

NOISE_TRANSFORMS = [
    lambda s: s,
    lambda s: s.lower(),
    lambda s: s.upper() if random.random() < 0.15 else s,
    lambda s: s.replace(",", ""),
    lambda s: s + "..",
    lambda s: s.replace("  ", " "),
]


# ---------------------------------------------------------------------------
# Hard cases: genuinely ambiguous complaints that sit between two departments.
# Real portals are full of these, and a model that never sees them reports
# unrealistically perfect accuracy. Each entry maps to the label a trained clerk
# would most likely assign, while the text remains legitimately confusable.
# ---------------------------------------------------------------------------
AMBIGUOUS: list[tuple[str, str]] = [
    ("Street light not working and road is fully dark, accidents happening", "electricity"),
    ("Road dug up for pipe laying and never restored at {place}", "roads_transport"),
    ("Water pipeline broken because of road widening work in {place}", "water_supply"),
    ("Drainage water flowing onto the main road at {place}", "sanitation_waste"),
    ("Sewage overflow near hospital in {place}, patients affected", "sanitation_waste"),
    ("No water in government hospital toilets at {place}", "health_medical"),
    ("Power cut in hospital during operation at {place}", "electricity"),
    ("School has no drinking water connection in {place}", "education"),
    ("School toilet blocked and unhygienic in {place}", "education"),
    ("Bribe demanded for water connection at {place}", "corruption_bribery"),
    ("Bribe demanded at RTO for licence in {place}", "corruption_bribery"),
    ("Officer demanded money for pension file at {place}", "corruption_bribery"),
    ("Pension file pending at village office {place} for months", "welfare_pension"),
    ("Ration card and income certificate both pending at {place}", "revenue_certificates"),
    ("Stray dogs attacking people near garbage dump at {place}", "municipal_admin"),
    ("Garbage dump attracting stray dogs and mosquitoes at {place}", "sanitation_waste"),
    ("Illegal building construction blocking public drain at {place}", "municipal_admin"),
    ("Lorries damaging the road and speeding through {place}", "transport_rto"),
    ("Potholes causing bus accidents on {place} route", "roads_transport"),
    ("Bus driver rash driving on damaged road at {place}", "transport_rto"),
    ("Police not acting on illegal sand mining at {place}", "police_safety"),
    ("Illegal quarry operating with official support at {place}", "corruption_bribery"),
    ("Electric wire fallen on the road after storm at {place}", "electricity"),
    ("Tree fallen on electric line and blocking road at {place}", "electricity"),
    ("Fever cases rising due to stagnant water in {place}", "health_medical"),
    ("Mosquito breeding in stagnant water at {place}", "sanitation_waste"),
    ("Anganwadi building leaking and children at risk in {place}", "education"),
    ("Anganwadi not giving nutrition kit in {place}", "welfare_pension"),
    ("Ambulance could not reach due to bad road at {place}", "roads_transport"),
    ("Land record correction pending, tax not accepted at {place}", "revenue_certificates"),
    ("Property tax receipt and building number not given at {place}", "municipal_admin"),
    ("Water bill wrong and office staff refuse to correct it at {place}", "water_supply"),
    ("Meter reader not visiting, wrong electricity bill at {place}", "electricity"),
    ("Public tap area is muddy and full of waste at {place}", "sanitation_waste"),
    ("Bus stop has no light and is unsafe for women at {place}", "police_safety"),
    ("Auto drivers overcharging and misbehaving at {place} stand", "transport_rto"),
]

# Terse fragments - how a lot of citizens actually type on mobile.
TERSE: list[tuple[str, str]] = [
    ("no water {place}", "water_supply"),
    ("water problem", "water_supply"),
    ("tap dry 3 days", "water_supply"),
    ("current illa", "electricity"),
    ("no power {place}", "electricity"),
    ("street light off", "electricity"),
    ("road bad {place}", "roads_transport"),
    ("pothole", "roads_transport"),
    ("garbage not taken", "sanitation_waste"),
    ("waste smell {place}", "sanitation_waste"),
    ("no doctor phc", "health_medical"),
    ("medicine not available", "health_medical"),
    ("theft again {place}", "police_safety"),
    ("police no action", "police_safety"),
    ("teacher absent school", "education"),
    ("certificate delay", "revenue_certificates"),
    ("pension not credited", "welfare_pension"),
    ("bribe demanded", "corruption_bribery"),
    ("licence pending rto", "transport_rto"),
    ("stray dogs", "municipal_admin"),
]

_KEYBOARD_NEIGHBOURS = {
    "a": "sq", "b": "vn", "c": "xv", "d": "sf", "e": "wr", "f": "dg", "g": "fh",
    "h": "gj", "i": "uo", "j": "hk", "k": "jl", "l": "k", "m": "n", "n": "bm",
    "o": "ip", "p": "o", "q": "wa", "r": "et", "s": "ad", "t": "ry", "u": "yi",
    "v": "cb", "w": "qe", "x": "zc", "y": "tu", "z": "x",
}


def _typo(text: str, rng: random.Random, rate: float = 0.04) -> str:
    """Introduce realistic mobile-keyboard typos."""
    chars = list(text)
    for i, ch in enumerate(chars):
        if ch.lower() in _KEYBOARD_NEIGHBOURS and rng.random() < rate:
            roll = rng.random()
            if roll < 0.5:
                chars[i] = rng.choice(_KEYBOARD_NEIGHBOURS[ch.lower()])
            elif roll < 0.75:
                chars[i] = ""                      # dropped character
            else:
                chars[i] = ch + ch                 # doubled character
    return "".join(chars)


def _drop_words(text: str, rng: random.Random, rate: float = 0.12) -> str:
    """Randomly drop filler words to mimic terse, ungrammatical input."""
    words = text.split()
    if len(words) <= 4:
        return text
    kept = [w for w in words if rng.random() > rate]
    return " ".join(kept) if len(kept) >= 3 else text


def _fill(template: str, rng: random.Random) -> str:
    return template.format(place=rng.choice(PLACES), duration=rng.choice(DURATIONS))


def generate(n_per_category: int = 420, seed: int = 42) -> list[dict]:
    """Generate a labelled corpus of grievance texts."""
    rng = random.Random(seed)
    rows: list[dict] = []

    for category in CATEGORY_KEYS:
        templates = TEMPLATES[category]
        for _ in range(n_per_category):
            text = _fill(rng.choice(templates), rng)

            urgent = rng.random() < 0.28
            frequent = rng.random() < 0.25
            severe = rng.random() < 0.22

            if rng.random() < 0.6:
                text = rng.choice(POLITE_PREFIXES) + text
            if urgent:
                text = rng.choice(URGENCY_PREFIXES) + text
            if severe:
                text += rng.choice(SEVERITY_SUFFIXES[category])
            if frequent:
                text += rng.choice(FREQUENCY_SUFFIXES)
            if rng.random() < 0.5:
                text += rng.choice(POLITE_SUFFIXES)

            text = rng.choice(NOISE_TRANSFORMS)(text).strip()

            # Realistic noise: typos and dropped words on a large share of rows.
            if rng.random() < 0.35:
                text = _typo(text, rng)
            if rng.random() < 0.25:
                text = _drop_words(text, rng)

            rows.append(
                {
                    "text": text,
                    "category": category,
                    "urgency_flag": int(urgent),
                    "frequency_flag": int(frequent),
                    "severity_flag": int(severe),
                }
            )

    # ---- hard, genuinely ambiguous cross-department cases ----
    n_ambiguous = max(1, int(n_per_category * len(CATEGORY_KEYS) * 0.18))
    for _ in range(n_ambiguous):
        template, label = rng.choice(AMBIGUOUS)
        text = _fill(template, rng) if "{place}" in template else template
        urgent = rng.random() < 0.3
        severe = rng.random() < 0.3
        frequent = rng.random() < 0.25
        if urgent:
            text = rng.choice(URGENCY_PREFIXES) + text
        if frequent:
            text += rng.choice(FREQUENCY_SUFFIXES)
        if rng.random() < 0.3:
            text = _typo(text, rng)
        rows.append({
            "text": text.strip(),
            "category": label,
            "urgency_flag": int(urgent),
            "frequency_flag": int(frequent),
            "severity_flag": int(severe),
        })

    # ---- terse one-liners ----
    n_terse = max(1, int(n_per_category * len(CATEGORY_KEYS) * 0.10))
    for _ in range(n_terse):
        template, label = rng.choice(TERSE)
        text = _fill(template, rng) if "{place}" in template else template
        if rng.random() < 0.25:
            text = _typo(text, rng, rate=0.06)
        rows.append({
            "text": text.strip(),
            "category": label,
            "urgency_flag": 0,
            "frequency_flag": int("again" in text),
            "severity_flag": 0,
        })

    # ---- label noise: a small fraction of real tickets are misfiled by clerks ----
    n_noise = int(len(rows) * 0.02)
    for idx in rng.sample(range(len(rows)), n_noise):
        wrong = rng.choice([c for c in CATEGORY_KEYS if c != rows[idx]["category"]])
        rows[idx] = {**rows[idx], "category": wrong}

    rng.shuffle(rows)
    return rows


if __name__ == "__main__":  # pragma: no cover
    import csv
    import pathlib

    out = pathlib.Path(__file__).resolve().parents[1] / "data" / "grievances.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    data = generate()
    with out.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(data[0]))
        writer.writeheader()
        writer.writerows(data)
    print(f"wrote {len(data)} rows -> {out}")
