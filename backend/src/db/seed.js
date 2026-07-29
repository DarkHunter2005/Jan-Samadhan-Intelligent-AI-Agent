/**
 * Seeds departments, demo accounts and a set of realistic complaints.
 *
 * Complaints are pushed through the real submission pipeline (ML predict -> route)
 * so the seeded data exercises classification, duplicate detection and escalation
 * exactly as live traffic would.
 *
 * Usage:  npm run seed
 */
import bcrypt from 'bcryptjs';
import { customAlphabet, nanoid } from 'nanoid';
import { config } from '../config.js';
import { complaints, db, departments, history, users } from './index.js';
import * as ml from '../services/mlClient.js';
import { absorbIntoParent, computeDueAt, resolveDuplicate, routeComplaint } from '../services/routing.js';

const trackingCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);

const DEPARTMENTS = [
  ['KWA',  'Kerala Water Authority',            'water_supply',         48,  ['Ward Officer', 'Assistant Engineer', 'Executive Engineer', 'District Collector']],
  ['KSEB', 'State Electricity Board',           'electricity',          24,  ['Section Officer', 'Assistant Engineer', 'Executive Engineer', 'Chief Engineer']],
  ['PWD',  'Public Works Department',           'roads_transport',      120, ['Overseer', 'Assistant Engineer', 'Executive Engineer', 'Superintending Engineer']],
  ['MHW',  'Municipal Health Wing',             'sanitation_waste',     72,  ['Sanitation Supervisor', 'Health Inspector', 'Health Officer', 'Municipal Secretary']],
  ['DHS',  'Department of Health Services',     'health_medical',       24,  ['Hospital Superintendent', 'District Medical Officer', 'Director of Health Services']],
  ['POL',  'State Police',                      'police_safety',        12,  ['Station House Officer', 'Circle Inspector', 'Superintendent of Police', 'DIG']],
  ['EDU',  'Department of General Education',   'education',            120, ['Headmaster', 'Assistant Educational Officer', 'District Educational Officer']],
  ['REV',  'Revenue Department',                'revenue_certificates', 96,  ['Village Officer', 'Tahsildar', 'Sub Collector', 'District Collector']],
  ['SJD',  'Social Justice Department',         'welfare_pension',      168, ['Panchayat Secretary', 'Welfare Officer', 'District Social Justice Officer']],
  ['LSG',  'Local Self Government',             'municipal_admin',      120, ['Junior Superintendent', 'Municipal Secretary', 'Regional Joint Director']],
  ['VACB', 'Vigilance & Anti-Corruption Bureau','corruption_bribery',   48,  ['Vigilance Inspector', 'Vigilance DySP', 'Vigilance SP', 'Director VACB']],
  ['MVD',  'Motor Vehicles Department',         'transport_rto',        96,  ['Assistant MVI', 'Motor Vehicle Inspector', 'RTO', 'Transport Commissioner']],
];

const DEMO_USERS = [
  ['Admin User',      'admin@gov.in',    'admin',   null,   'Erattupetta'],
  ['Anita Water',     'kwa@gov.in',      'officer', 'KWA',  'Erattupetta'],
  ['Biju Power',      'kseb@gov.in',     'officer', 'KSEB', 'Erattupetta'],
  ['Chandran Roads',  'pwd@gov.in',      'officer', 'PWD',  'Erattupetta'],
  ['Deepa Health',    'mhw@gov.in',      'officer', 'MHW',  'Erattupetta'],
  ['Elias Medical',   'dhs@gov.in',      'officer', 'DHS',  'Erattupetta'],
  ['Firoz Police',    'pol@gov.in',      'officer', 'POL',  'Erattupetta'],
  ['Geetha Revenue',  'rev@gov.in',      'officer', 'REV',  'Erattupetta'],
  ['Hari Welfare',    'sjd@gov.in',      'officer', 'SJD',  'Erattupetta'],
  ['Indu Municipal',  'lsg@gov.in',      'officer', 'LSG',  'Erattupetta'],
  ['Ravi Kumar',      'ravi@example.com','citizen', null,   'Erattupetta'],
  ['Sunitha Jose',    'sunitha@example.com','citizen', null,'Erattupetta'],
  ['Thomas Mathew',   'thomas@example.com','citizen', null, 'Palai'],
];

// Realistic complaint mix: covers every department, both languages, urgent and
// routine, plus deliberate near-duplicates to demonstrate the dedup engine.
const DEMO_COMPLAINTS = [
  ['URGENT! A live electric wire has fallen on the road near the government school at Erattupetta. A child was injured this morning. Please act immediately!', 'Erattupetta', 'en'],
  ['No water supply in ward 7 Erattupetta for the last 10 days. The tap is completely dry and we are buying water. I have complained three times already, no action taken.', 'Erattupetta', 'en'],
  ['Ward 7 has had no water supply for over a week now, taps are totally dry. Please help us.', 'Erattupetta', 'en'],
  ['Sewage from the blocked drain is overflowing near the government hospital. Patients are falling sick and dengue cases are increasing rapidly.', 'Erattupetta', 'en'],
  ['Large pothole on the main road near market junction is causing accidents. Two accidents already happened here, one person was seriously injured.', 'Erattupetta', 'en'],
  ['Sir, my income certificate application is pending at the village office for two months. Because of this delay my daughter is losing her college admission.', 'Erattupetta', 'en'],
  ['The village officer demanded a bribe of 5000 rupees to clear my building permit file. I have recorded evidence and I fear retaliation.', 'Erattupetta', 'en'],
  ['Old age pension not credited for three months in Palai. I am bedridden and have no other income for food or medicine.', 'Palai', 'en'],
  ['Garbage has not been collected from our street for two weeks. Terrible smell and stray dogs everywhere.', 'Palai', 'en'],
  ['No doctor available at the PHC in Palai during duty hours. Medicines are also out of stock.', 'Palai', 'en'],
  ['Street light not working near the temple road for the past week. It is very dark and unsafe for women at night.', 'Palai', 'en'],
  ['FIR not registered at the police station despite my complaint about repeated theft in our colony. No patrolling at night.', 'Erattupetta', 'en'],
  ['Teacher shortage at the government school in Poonjar for the last three months. Children are losing classes.', 'Poonjar', 'en'],
  ['Driving licence application pending for two months at the RTO. No response to follow ups.', 'Kottayam town', 'en'],
  ['Stray dogs attacked two children near the garbage dump last week. Municipality is not taking any action.', 'Erattupetta', 'en'],
  ['Vellam varunnilla ward 3 il, 5 divasam ayi. Dayavayi nadapadi edukkuka.', 'Erattupetta', 'ml'],
  ['Bijli nahi hai hamare area me do din se. Bahut pareshani ho rahi hai.', 'Poonjar', 'hi'],
  ['Building permit application pending at the municipality office for 45 days without any update.', 'Erattupetta', 'en'],
  ['Water pipe burst near the school junction, drinking water is flowing wastefully onto the road all day.', 'Teekoy', 'en'],
  ['Anganwadi building roof is leaking badly and children are at risk during rain.', 'Teekoy', 'en'],
];

function reset() {
  db.exec('DELETE FROM status_history; DELETE FROM complaints; DELETE FROM users; DELETE FROM departments;');
}

async function main() {
  console.log('[seed] resetting database...');
  reset();

  for (const [code, name, category_key, sla_hours, chain] of DEPARTMENTS) {
    departments.upsert({ code, name, category_key, sla_hours, escalation_json: JSON.stringify(chain) });
  }
  console.log(`[seed] ${DEPARTMENTS.length} departments`);

  const created = {};
  for (const [name, email, role, department, locality] of DEMO_USERS) {
    const user = {
      id: `USR-${nanoid(10)}`,
      name, email,
      phone: '9400000000',
      password_hash: bcrypt.hashSync('password123', 10),
      role, department, locality,
    };
    users.create(user);
    created[email] = user;
  }
  console.log(`[seed] ${DEMO_USERS.length} users (password for all: password123)`);

  const citizens = [created['ravi@example.com'], created['sunitha@example.com'], created['thomas@example.com']];
  const health = await ml.health();
  console.log(`[seed] ML service reachable: ${health.reachable}`);

  let merged = 0;
  for (let i = 0; i < DEMO_COMPLAINTS.length; i += 1) {
    const [text, locality, language] = DEMO_COMPLAINTS[i];
    const citizen = citizens[i % citizens.length];

    const candidates = complaints.duplicateCandidates({ locality, limit: config.ml.duplicateCandidateLimit });
    const prediction = await ml.predict({
      text, locality, language,
      candidates: candidates.map((c) => ({ id: c.id, text: c.text, category: c.category, locality: c.locality, status: c.status })),
    });

    const dup = resolveDuplicate(prediction);
    const route = routeComplaint(prediction);
    const isMerged = dup.merge && dup.duplicate_of;
    if (isMerged) merged += 1;

    // Spread creation times over the last 12 days so the dashboard trend chart and
    // the SLA/escalation logic have realistic history to work with.
    const ageHours = Math.round((DEMO_COMPLAINTS.length - i) * 14);
    const createdAt = new Date(Date.now() - ageHours * 3600 * 1000);
    const id = `GRV-${createdAt.getFullYear()}-${trackingCode()}`;

    complaints.insert({
      id,
      user_id: citizen.id,
      citizen_name: citizen.name,
      citizen_phone: citizen.phone,
      text, language, locality, address: null,
      category: prediction.category,
      category_label: prediction.category_label,
      confidence: prediction.confidence,
      department_code: route.department_code,
      department_name: route.department_name,
      priority: prediction.priority,
      priority_score: prediction.priority_score,
      urgency: prediction.urgency,
      severity_score: prediction.severity_score ?? null,
      sla_hours: route.sla_hours,
      ml_json: JSON.stringify(prediction),
      needs_review: prediction.needs_human_review ? 1 : 0,
      duplicate_of: dup.duplicate_of,
      duplicate_score: dup.duplicate_score,
      repeat_count: dup.repeat_count,
      status: isMerged ? 'duplicate' : route.status,
      assigned_to: isMerged ? null : route.assigned_to,
      due_at: isMerged ? null : computeDueAt(route.sla_hours, createdAt),
    });

    // Backdate so SLA breaches exist in the seeded data.
    const ts = createdAt.toISOString().replace('T', ' ').slice(0, 19);
    db.prepare('UPDATE complaints SET created_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, id);

    history.add({
      complaint_id: id,
      from_status: null,
      to_status: isMerged ? 'duplicate' : route.status,
      note: isMerged
        ? `Detected as duplicate of ${dup.duplicate_of} (similarity ${(dup.duplicate_score * 100).toFixed(0)}%).`
        : `Auto-classified as "${prediction.category_label}" and routed to ${route.department_name}. Priority: ${prediction.priority}.`,
      actor_id: null,
      actor_role: 'system',
    });

    if (isMerged) absorbIntoParent(dup.duplicate_of, prediction.priority, null);
  }

  // Give a few complaints realistic progress so dashboards are not all "routed".
  const all = complaints.search({ limit: 100, offset: 0 }).rows.filter((c) => c.status === 'routed');
  for (const c of all.slice(0, 4)) {
    complaints.update(c.id, { status: 'in_progress' });
    history.add({ complaint_id: c.id, from_status: 'routed', to_status: 'in_progress',
                  note: 'Site inspection scheduled.', actor_id: null, actor_role: 'officer' });
  }
  for (const c of all.slice(4, 7)) {
    complaints.update(c.id, {
      status: 'resolved',
      resolved_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
      resolution_note: 'Issue rectified by the field team and verified on site.',
    });
    history.add({ complaint_id: c.id, from_status: 'routed', to_status: 'resolved',
                  note: 'Issue rectified by the field team and verified on site.',
                  actor_id: null, actor_role: 'officer' });
  }

  const stats = complaints.stats();
  console.log(`[seed] ${DEMO_COMPLAINTS.length} complaints (${merged} auto-merged as duplicates)`);
  console.log('[seed] status mix:', stats.byStatus.map((s) => `${s.status}=${s.n}`).join(' '));
  console.log('[seed] priority mix:', stats.byPriority.map((s) => `${s.priority}=${s.n}`).join(' '));
  console.log('[seed] overdue:', stats.totals.overdue, '| needs review:', stats.totals.needs_review);
  console.log('[seed] done.');
}

main().catch((err) => { console.error('[seed] failed:', err); process.exit(1); });
