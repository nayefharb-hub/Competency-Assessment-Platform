#!/usr/bin/env python3
"""Generate a self-contained seed.sql from the verified T0 extraction.

Runnable straight from the Supabase SQL Editor — no Node, no network from here.
Uses temp staging tables so foreign keys resolve by code, not by hand-written UUIDs.
"""
import json

SRC = "/home/user/Competency-Assessment-Platform/data/seed/icb4-framework.json"
OUT = "/home/user/Competency-Assessment-Platform/supabase/seed.sql"

d = json.load(open(SRC, encoding="utf8"))

GLOSS = {
    0: "I have no real awareness of this yet.",
    1: "I know it exists and understand the idea, but I haven’t really applied it.",
    2: "I can do this, but I still need guidance — mostly on straightforward projects.",
    3: "I do this on my own, on projects of limited complexity.",
    4: "I do this confidently on complex projects, and I coach others.",
    5: "I’m the person others come to; I adapt and improve how it’s done.",
}
PROFILES = ["Entry", "Intermediate", "Advanced", "Master"]


def q(v):
    """Quote a SQL string literal, or NULL."""
    if v is None:
        return "null"
    return "'" + str(v).replace("'", "''") + "'"


def n(v):
    return "null" if v is None else str(v)


L = []
w = L.append

w("-- seed.sql — ICB4 framework seed data")
w("-- Generated from data/seed/icb4-framework.json (verified by the T0 extractor).")
w("-- Safe to run in the Supabase SQL Editor AFTER 0001_init.sql and 0002_rls.sql.")
w("-- Re-running is blocked by the unique (name, version) constraint on framework;")
w("-- to reseed, first: delete from public.framework where name='IPMA ICB4';")
w("")
w("begin;")
w("")

# ---------- scale ----------
w("-- rating scale (APM 0-5) --------------------------------------------------")
w(f"insert into public.scale (name, axis) values ({q(d['scale']['name'])}, {q(d['scale']['axis'])});")
w("")
w("insert into public.scale_level (scale_id, level, label, knowledge, application, kib_gloss)")
w("select s.id, v.level, v.label, v.knowledge, v.application, v.gloss")
w("from public.scale s,")
w("(values")
rows = []
for lv in d["scale"]["levels"]:
    rows.append(
        f"  ({lv['level']}, {q(lv['label'])}, {q(lv.get('knowledge'))}, "
        f"{q(lv.get('application'))}, {q(GLOSS.get(lv['level']))})"
    )
w(",\n".join(rows))
w(") as v(level, label, knowledge, application, gloss)")
w(f"where s.name = {q(d['scale']['name'])};")
w("")

# ---------- framework ----------
w("-- framework ---------------------------------------------------------------")
w("insert into public.framework (name, version, scale_id)")
w(f"select 'IPMA ICB4', 'v4.0.1', s.id from public.scale s where s.name = {q(d['scale']['name'])};")
w("")

# ---------- areas ----------
w("-- areas -------------------------------------------------------------------")
w("insert into public.competence_area (framework_id, code, name, sort_order)")
w("select f.id, v.code, v.name, v.sort")
w("from public.framework f, (values")
rows = [f"  ({q(a['code'])}, {q(a['name'])}, {i})" for i, a in enumerate(d["areas"])]
w(",\n".join(rows))
w(") as v(code, name, sort)")
w("where f.name = 'IPMA ICB4' and f.version = 'v4.0.1';")
w("")

# ---------- competence elements ----------
ce_target = {t["ce_code"]: t["target"] for t in d["ce_targets"]}
w("-- competence elements (target = APM published value, never computed) -------")
w("insert into public.competence_element (framework_id, area_id, code, name, target_level, sort_order)")
w("select f.id, a.id, v.code, v.name, v.target, v.sort")
w("from public.framework f")
w("join public.competence_area a on a.framework_id = f.id")
w(", (values")
rows = []
for i, ce in enumerate(d["competence_elements"]):
    rows.append(
        f"  ({q(ce['code'])}, {q(ce['name'])}, {q(ce['area'])}, "
        f"{n(ce_target.get(ce['code']))}, {i})"
    )
w(",\n".join(rows))
w(") as v(code, name, area_name, target, sort)")
w("where f.name = 'IPMA ICB4' and f.version = 'v4.0.1' and a.name = v.area_name;")
w("")

# ---------- controls ----------
w("-- controls (ICB4 source text — never edited) -------------------------------")
w("insert into public.control (framework_id, ce_id, code, indicator, description, active,")
w("                            priority, reason, kib_note, apm_competence,")
w("                            target_level, target_source, sort_order)")
w("select f.id, ce.id, v.code, v.indicator, v.description, v.active,")
w("       v.priority, v.reason, v.kib_note, v.apm_competence,")
w("       v.target_level, v.target_source, v.sort")
w("from public.framework f")
w("join public.competence_element ce on ce.framework_id = f.id")
w(", (values")
rows = []
for i, c in enumerate(d["controls"]):
    rows.append(
        f"  ({q(c['code'])}, {q(c['ce_code'])}, {q(c['indicator'])}, {q(c['description'])}, "
        f"{'true' if c['active'] else 'false'}, {q(c['priority'])}, {q(c['reason'])}, "
        f"{q(c['kib_note'])}, {q(c['apm_competence'])}, {n(c['target_level'])}, "
        f"{q(c['target_source'])}, {i})"
    )
w(",\n".join(rows))
w(") as v(code, ce_code, indicator, description, active, priority, reason,")
w("       kib_note, apm_competence, target_level, target_source, sort)")
w("where f.name = 'IPMA ICB4' and f.version = 'v4.0.1' and ce.code = v.ce_code;")
w("")

# ---------- measures ----------
w("-- measures (reference only — never scored) ---------------------------------")
measures = [m for m in d["measures"] if m.get("text")]
CHUNK = 150
for start in range(0, len(measures), CHUNK):
    chunk = measures[start:start + CHUNK]
    w("insert into public.measure (control_id, seq, text)")
    w("select c.id, v.seq, v.text")
    w("from public.control c")
    w("join public.framework f on f.id = c.framework_id")
    w(", (values")
    rows = [f"  ({q(m['control_code'])}, {m['no']}, {q(m['text'])})" for m in chunk]
    w(",\n".join(rows))
    w(") as v(control_code, seq, text)")
    w("where f.name = 'IPMA ICB4' and f.version = 'v4.0.1' and c.code = v.control_code;")
    w("")

# ---------- benchmark profiles ----------
w("-- benchmark profiles (APM role profiles) -----------------------------------")
w("insert into public.benchmark_profile (framework_id, name, sort_order)")
w("select f.id, v.name, v.sort from public.framework f, (values")
w(",\n".join(f"  ({q(p)}, {i})" for i, p in enumerate(PROFILES)))
w(") as v(name, sort)")
w("where f.name = 'IPMA ICB4' and f.version = 'v4.0.1';")
w("")

w("-- benchmark targets (null = APM marks it not relevant at that level) --------")
w("insert into public.benchmark_target (profile_id, apm_competence, level)")
w("select p.id, v.competence, v.level")
w("from public.benchmark_profile p")
w("join public.framework f on f.id = p.framework_id")
w(", (values")
rows = []
for b in d["benchmarks"]:
    comp = b.get("apm_competence")
    if not comp:
        continue
    for p in PROFILES:
        val = b.get(p.lower())
        lvl = val if isinstance(val, int) else None
        rows.append(f"  ({q(p)}, {q(comp)}, {n(lvl)})")
w(",\n".join(rows))
w(") as v(profile, competence, level)")
w("where f.name = 'IPMA ICB4' and f.version = 'v4.0.1' and p.name = v.profile;")
w("")

# ---------- verification ----------
w("-- verification: these must match the T0 extraction exactly -----------------")
w("do $$")
w("declare c_all int; c_active int; c_ce int; c_area int; c_meas int; c_lvl int;")
w("begin")
w("  select count(*) into c_all    from public.control;")
w("  select count(*) into c_active from public.control where active;")
w("  select count(*) into c_ce     from public.competence_element;")
w("  select count(*) into c_area   from public.competence_area;")
w("  select count(*) into c_meas   from public.measure;")
w("  select count(*) into c_lvl    from public.scale_level;")
w(f"  if c_all <> {len(d['controls'])} then raise exception 'controls: got %, expected {len(d['controls'])}', c_all; end if;")
w("  if c_active <> 132 then raise exception 'active controls: got %, expected 132', c_active; end if;")
w(f"  if c_ce <> {len(d['competence_elements'])} then raise exception 'elements: got %, expected {len(d['competence_elements'])}', c_ce; end if;")
w(f"  if c_area <> {len(d['areas'])} then raise exception 'areas: got %, expected {len(d['areas'])}', c_area; end if;")
w(f"  if c_meas <> {len(measures)} then raise exception 'measures: got %, expected {len(measures)}', c_meas; end if;")
w("  if c_lvl <> 6 then raise exception 'scale levels: got %, expected 6', c_lvl; end if;")
w("  raise notice 'Seed verified: % controls (% active), % elements, % measures.', c_all, c_active, c_ce, c_meas;")
w("end $$;")
w("")
w("commit;")

body = "\n".join(L) + "\n"
open(OUT, "w", encoding="utf8").write(body)
print(f"wrote {OUT}")
print(f"  controls={len(d['controls'])} measures={len(measures)} bytes={len(body)}")
