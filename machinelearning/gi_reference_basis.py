"""
Kapeng Barako / Batangas Liberica GI — Manual of Specifications reference basis.

Derived from the official drafting package folders:
  - PART 1: Justification for the Request for Protection
      (Introduction & Reputation, History of Kapeng Barako, Physical link to the territory)
  - PART 2: Technical Part
      (General Description, Specific Description, Production Process)
  - Control & Traceability (labelling is outside this upload phase)

Analysis is qualitative (theme coverage + narrative), not a keyword percentage score.
"""

from __future__ import annotations

import re
from typing import Callable, Iterable

TermMatcher = Callable[[str, str], bool]

# Critical themes must be at least partially addressed for Ready when analyzing
# a full MoP-style document. Upload-zone analyses use the subset most relevant
# to that zone (mapped below).
REFERENCE_THEMES: list[dict] = [
    {
        "id": "reputation_origin",
        "part": "Part I — Justification",
        "label": "Introduction, reputation & origin",
        "critical": True,
        "expectation": (
            "Explain why Batangas / Lipa Kapeng Barako deserves GI protection: "
            "product identity (Coffea liberica / Barako), geographic origin, "
            "and reputation among producers and consumers."
        ),
        "signals": [
            "kapeng barako",
            "barako",
            "liberica",
            "coffea liberica",
            "lipa",
            "batangas",
            "reputation",
            "geographical indication",
            "geographical origin",
            "distinctive",
            "tradition",
        ],
    },
    {
        "id": "history",
        "part": "Part I — Justification",
        "label": "History of Kapeng Barako",
        "critical": True,
        "expectation": (
            "Narrate the historical development of Kapeng Barako in Batangas: "
            "introduction of the crop, cultural role, and continuity of production."
        ),
        "signals": [
            "history",
            "historical",
            "century",
            "spanish",
            "colonial",
            "tradition",
            "heritage",
            "farmers federation",
            "bacoffed",
            "batangas coffee",
        ],
    },
    {
        "id": "physical_link",
        "part": "Part I — Justification",
        "label": "Physical / causal link to the territory",
        "critical": True,
        "expectation": (
            "Show how Batangas geography (volcanic soils, slope, climate Type I/III, "
            "elevation, rainfall) causally shapes Liberica quality — not just naming the place."
        ),
        "signals": [
            "volcanic",
            "soil",
            "climate",
            "elevation",
            "rainfall",
            "slope",
            "taal",
            "physiography",
            "suitability",
            "causal link",
            "territory",
            "microclimate",
            "temperature",
        ],
    },
    {
        "id": "morphology",
        "part": "Part II — Technical (General Description)",
        "label": "Morphological characteristics",
        "critical": True,
        "expectation": (
            "Describe Liberica plant, cherry, and bean morphology (height, leaves, "
            "flowers, oblong cherries, almond-shaped beans, size vs Arabica/Robusta)."
        ),
        "signals": [
            "morphological",
            "plant height",
            "leaf",
            "elliptic",
            "cherry",
            "bean",
            "almond",
            "inflorescence",
            "petiole",
            "root system",
            "nipple",
            "creamy-white",
        ],
    },
    {
        "id": "harvesting_index",
        "part": "Part II — Technical (General Description)",
        "label": "Harvesting index",
        "critical": False,
        "expectation": (
            "State maturity indicators for picking (color progression, firmness, "
            "fully grown cherries) aligned with quality Liberica harvest practice."
        ),
        "signals": [
            "harvesting index",
            "maturity",
            "ripe",
            "cherry color",
            "firmness",
            "harvest",
            "picking",
        ],
    },
    {
        "id": "sensory",
        "part": "Part II — Technical (General Description)",
        "label": "Sensory profile (taste / acidity / body)",
        "critical": True,
        "expectation": (
            "Document sensory attributes of Barako/Liberica: flavor notes, acidity range, "
            "body/mouthfeel, and how roasted or ground product is characterized."
        ),
        "signals": [
            "sensory",
            "aroma",
            "acidity",
            "body",
            "flavor",
            "bitterness",
            "sweetness",
            "roast",
            "cupping",
            "taste",
        ],
    },
    {
        "id": "genetic_profile",
        "part": "Part II — Technical (General Description)",
        "label": "Genetic / authenticity profile",
        "critical": False,
        "expectation": (
            "Reference molecular or genetic verification of Coffea liberica (e.g. BARAKO Project / "
            "matK gene work) as a baseline for authenticity."
        ),
        "signals": [
            "genetic",
            "dna",
            "matk",
            "molecular",
            "barako project",
            "genbank",
            "authenticity",
            "pcr",
        ],
    },
    {
        "id": "product_specification",
        "part": "Part II — Technical (Specific Description)",
        "label": "Specific product description (roasted / ground)",
        "critical": True,
        "expectation": (
            "Specify roasted beans and/or ground coffee attributes: Liberica aroma, "
            "degree of roast (light/medium/dark), taste/body, and acidity."
        ),
        "signals": [
            "roasted coffee",
            "ground coffee",
            "degree of roast",
            "light roast",
            "medium roast",
            "dark roast",
            "roasted beans",
            "specific description",
        ],
    },
    {
        "id": "production_process",
        "part": "Part II — Technical (Production Process)",
        "label": "Production process (farm to finished product)",
        "critical": True,
        "expectation": (
            "Detail production: planting materials (BPI/NSIC), soil/layout, transplanting, "
            "care, harvesting, post-harvest, processing, and roasting steps for Liberica."
        ),
        "signals": [
            "production process",
            "planting materials",
            "seedling",
            "transplanting",
            "weeding",
            "mulching",
            "fertilization",
            "pruning",
            "post-harvest",
            "pulping",
            "drying",
            "roasting",
            "nsic",
            "bureau of plant industry",
            "planting distance",
        ],
    },
    {
        "id": "internal_control",
        "part": "Part III — Control & Traceability",
        "label": "Internal control (producer registration)",
        "critical": True,
        "expectation": (
            "Require growers to be registered with Batangas Coffee Farmers Federation (BaCoFFed) "
            "or equivalent internal control body."
        ),
        "signals": [
            "bacoffed",
            "batangas coffee farmers federation",
            "registered",
            "internal control",
            "membership",
            "producers organization",
            "quality control",
        ],
    },
    {
        "id": "traceability_system",
        "part": "Part III — Control & Traceability",
        "label": "Traceability & records",
        "critical": True,
        "expectation": (
            "Describe how Provincial Technical Working Group and BaCoFFed maintain records "
            "and control compliance with the Code of Practice; LGU certificate of locality."
        ),
        "signals": [
            "traceability",
            "technical working group",
            "ptwg",
            "code of practice",
            "certificate of locality",
            "records",
            "lgu",
            "agriculturist",
            "batch",
            "lot",
        ],
    },
    {
        "id": "labelling_seal",
        "part": "Labelling (outside Phase 3 upload)",
        "label": "Labelling & distinctive seal",
        "critical": False,
        "expectation": (
            "Provide a distinctive Batangas Kapeng Barako seal and rule that only "
            "compliant producers may use it. Not required for the Control & Traceability phase card."
        ),
        "signals": [
            "labelling",
            "labeling",
            "seal",
            "logo",
            "label",
            "mark",
            "compliant producers",
            "code of practice",
        ],
    },
]

# Map IPOPHL upload-zone task_ids to the themes that document should primarily cover.
# Zones mirror PART 1 / PART 2 folders + Control & Traceability (no labelling card).
TASK_THEME_IDS: dict[str, list[str]] = {
    "phase1-introduction": ["reputation_origin"],
    "phase1-history": ["history"],
    "phase1-physical-link": ["physical_link"],
    "phase2-general": [
        "morphology",
        "harvesting_index",
        "sensory",
        "genetic_profile",
    ],
    "phase2-specific": ["product_specification", "sensory"],
    "phase2-production": ["production_process"],
    "phase3-control": ["internal_control", "traceability_system"],
    # Legacy procedural zones → nearest MoP themes
    "phase1-product": [
        "reputation_origin",
        "history",
        "physical_link",
        "morphology",
        "sensory",
        "product_specification",
    ],
    "phase1-entity": ["internal_control", "traceability_system"],
    "phase1-stakeholders": ["reputation_origin", "history", "internal_control"],
    "phase2-mop": [t["id"] for t in REFERENCE_THEMES if t["id"] != "labelling_seal"],
    "phase2-cert": [
        "genetic_profile",
        "traceability_system",
        "internal_control",
    ],
    "phase2-details": ["reputation_origin", "product_specification"],
    "phase3-filing": [t["id"] for t in REFERENCE_THEMES if t["critical"]],
    "phase3-payment": ["internal_control"],
    "phase4-exam": [t["id"] for t in REFERENCE_THEMES if t["critical"]],
    "phase4-response": [t["id"] for t in REFERENCE_THEMES if t["critical"]],
    "phase4-pub": ["reputation_origin"],
    "phase5-cert": ["traceability_system", "internal_control"],
    "phase5-compliance": [
        "internal_control",
        "traceability_system",
        "production_process",
    ],
}


def _default_matcher(text_lower: str, term: str) -> bool:
    t = (term or "").strip().lower()
    if not t:
        return False
    if " " in t or "-" in t:
        return t in text_lower
    return bool(re.search(rf"(?<![a-z0-9]){re.escape(t)}(?![a-z0-9])", text_lower))


def _themes_for_task(task_id: str | None) -> list[dict]:
    if not task_id:
        return list(REFERENCE_THEMES)
    ids = TASK_THEME_IDS.get(str(task_id).strip())
    if not ids:
        return list(REFERENCE_THEMES)
    by_id = {t["id"]: t for t in REFERENCE_THEMES}
    selected = [by_id[i] for i in ids if i in by_id]
    return selected or list(REFERENCE_THEMES)


def _coverage_level(hits: int, word_count: int) -> str:
    """Return well_covered | partial | missing — never a percentage."""
    if hits <= 0:
        return "missing"
    if hits >= 4 or (hits >= 2 and word_count >= 120):
        return "well_covered"
    return "partial"


def evaluate_against_reference(
    text: str,
    *,
    task_id: str | None = None,
    term_matches: TermMatcher | None = None,
) -> dict:
    """
    Qualitative MoP-basis review.

    Returns themes, status (Ready|Not Ready), narrative HTML, strengths, gaps,
    and improvement guidance — without a readiness percentage.
    """
    matcher = term_matches or _default_matcher
    raw = text or ""
    text_lower = raw.lower()
    words = re.findall(r"[A-Za-z0-9']+", raw)
    word_count = len(words)
    themes = _themes_for_task(task_id)

    assessed: list[dict] = []
    for theme in themes:
        hits = [s for s in theme["signals"] if matcher(text_lower, s)]
        level = _coverage_level(len(hits), word_count)
        assessed.append(
            {
                "id": theme["id"],
                "part": theme["part"],
                "label": theme["label"],
                "critical": bool(theme.get("critical")),
                "expectation": theme["expectation"],
                "coverage": level,
                "evidence_signals": hits[:8],
            }
        )

    critical = [t for t in assessed if t["critical"]]
    focus = critical or assessed
    missing_critical = [t for t in focus if t["coverage"] == "missing"]
    partial_critical = [t for t in focus if t["coverage"] == "partial"]
    strong = [t for t in assessed if t["coverage"] == "well_covered"]
    all_focus_strong = bool(focus) and all(t["coverage"] == "well_covered" for t in focus)

    # Ready when critical themes for this upload zone are covered.
    # Short outline-style MoP sections (e.g. Specific Description, Control) can be
    # Ready when every required theme is well covered, even under 80 words.
    if not focus:
        status = "Not Ready"
    elif missing_critical:
        status = "Not Ready"
    elif all_focus_strong and word_count >= 25:
        status = "Ready"
    elif len(partial_critical) > max(1, len(focus) // 2):
        status = "Not Ready"
    elif word_count < 80:
        status = "Not Ready"
    else:
        status = "Ready"

    strengths = [t["label"] for t in strong]
    gaps = [t["label"] for t in assessed if t["coverage"] != "well_covered"]
    missing_labels = [t["label"] for t in assessed if t["coverage"] == "missing"]
    partial_labels = [t["label"] for t in assessed if t["coverage"] == "partial"]

    doc_type = (task_id or "manual-of-specifications").replace("-", " ").title()
    narrative = _build_narrative(
        doc_type=doc_type,
        status=status,
        word_count=word_count,
        assessed=assessed,
        strengths=strengths,
        missing_labels=missing_labels,
        partial_labels=partial_labels,
    )

    improvements = _build_improvements(assessed, status)

    return {
        "status": status,
        "word_count": word_count,
        "themes": assessed,
        "strengths": strengths,
        "gaps": gaps,
        "missing_requirements": missing_labels,
        "detected_features": strengths + [s for t in assessed for s in t["evidence_signals"][:2]],
        "improvements": improvements,
        "shap_analysis": narrative,
        "reference_source": (
            "PART 1 Justification, PART 2 Technical Part, and Control & Traceability & Labelling "
            "for Batangas Kapeng Barako"
        ),
        "analysis_method": "mop_reference_qualitative",
    }


def _build_narrative(
    *,
    doc_type: str,
    status: str,
    word_count: int,
    assessed: list[dict],
    strengths: list[str],
    missing_labels: list[str],
    partial_labels: list[str],
) -> str:
    ready = status == "Ready"
    p1 = (
        f"<p>This review evaluates the uploaded <strong>{doc_type}</strong> document against the "
        f"Batangas Kapeng Barako Manual of Specifications drafting basis "
        f"(Part I Justification, Part II Technical description and production process, and "
        f"Part III–IV Control, Traceability, and Labelling). "
        f"About <strong>{word_count:,}</strong> words were extracted for review. "
        f"Overall classification: <strong>{'Ready' if ready else 'Not Ready'}</strong> — "
        f"{'the text substantively addresses the critical MoP themes expected for this filing zone'
           if ready else
           'critical MoP themes are still missing or only thinly addressed, so the document is not yet registration-ready'}.</p>"
    )

    if strengths:
        p2 = (
            "<p><strong>What is already working:</strong> The document shows useful coverage of "
            f"<strong>{', '.join(strengths[:6])}</strong>"
            f"{'…' if len(strengths) > 6 else ''}. "
            "These sections align with how an approved GI specification presents product identity, "
            "territorial link, technical description, and/or control systems for Liberica Barako.</p>"
        )
    else:
        p2 = (
            "<p><strong>What is already working:</strong> Little substantive MoP content was detected. "
            "The file may be a draft outline, an unrelated attachment, or text that could not be "
            "extracted cleanly. Expand with concrete Kapeng Barako specifications drawn from the "
            "Part I–IV reference package.</p>"
        )

    gap_bits = []
    if missing_labels:
        gap_bits.append(
            "fully missing: <strong>" + ", ".join(missing_labels[:5]) + "</strong>"
            + ("…" if len(missing_labels) > 5 else "")
        )
    if partial_labels:
        gap_bits.append(
            "only partially developed: <strong>" + ", ".join(partial_labels[:5]) + "</strong>"
            + ("…" if len(partial_labels) > 5 else "")
        )
    if gap_bits:
        p3 = (
            "<p><strong>Why it is not yet complete:</strong> "
            + "; ".join(gap_bits)
            + ". For GI examination, examiners look for a clear causal link to Batangas territory, "
            "Liberica morphological and sensory identity, a reproducible production process, "
            "BaCoFFed/PTWG control and traceability, and rules for the distinctive seal — "
            "not just naming “Barako” or “Lipa”.</p>"
        )
    else:
        p3 = (
            "<p><strong>Completeness:</strong> Critical themes appear adequately developed for this "
            "upload zone. Confirm companion documents still cover any Part I–IV topics not expected "
            "in this single file.</p>"
        )

    detail_rows = []
    for t in assessed:
        cov = t["coverage"].replace("_", " ")
        ev = ", ".join(t["evidence_signals"][:4]) if t["evidence_signals"] else "no clear signals"
        detail_rows.append(
            f"<li><strong>{t['label']}</strong> ({t['part']}) — {cov}. "
            f"Expectation: {t['expectation']} Evidence cues found: {ev}.</li>"
        )
    p4 = (
        "<p><strong>Theme-by-theme findings (MoP basis):</strong></p>"
        f"<ul>{''.join(detail_rows)}</ul>"
    )

    return p1 + p2 + p3 + p4


def _build_improvements(assessed: Iterable[dict], status: str) -> list[str]:
    recs: list[str] = []
    for t in assessed:
        if t["coverage"] == "well_covered":
            continue
        verb = "Add" if t["coverage"] == "missing" else "Strengthen"
        recs.append(f"{verb} «{t['label']}»: {t['expectation']}")
    if status == "Ready":
        recs.append(
            "Cross-check companion uploads so Part I reputation/history/link, Part II technical/"
            "process, and Part III–IV control/labelling remain consistent across the full package."
        )
    else:
        recs.append(
            "Revise using the Kapeng Barako MoP drafting package (PART 1, PART 2, and "
            "CONTROL & TRACEABILITY & LABELLING), then re-run analysis."
        )
    return recs[:8]
