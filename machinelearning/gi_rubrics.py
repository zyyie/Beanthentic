"""
Section rubrics for IPOPHL GI document analysis (Lipa Barako).

Inspired by IPOPHL GI Examination Manual (2026) Rule 10 structure and
approved GI filings such as Guimaras Mango (Code of Practice sections).
"""

from __future__ import annotations

from typing import Callable

# task_id -> list of {id, label, signals[]}
TASK_RUBRICS: dict[str, list[dict]] = {
    "phase1-product": [
        {"id": "product_identity", "label": "Product name & variety (Barako / Liberica)", "signals": ["lipa barako", "kapeng barako", "coffea liberica", "kape barako"]},
        {"id": "sensory_profile", "label": "Sensory / quality characteristics", "signals": ["flavor profile", "aroma", "taste", "distinctive quality", "cup profile"]},
        {"id": "geo_link", "label": "Geographical origin linkage", "signals": ["geographical origin", "lipa city", "batangas", "grown in"]},
        {"id": "visual_evidence", "label": "Product imagery or description evidence", "signals": ["photograph", "product photo", "product image", "description of the goods"]},
    ],
    "phase1-entity": [
        {"id": "applicant_body", "label": "Applicant / producers organization", "signals": ["applicant", "producers organization", "association", "cooperative"]},
        {"id": "legal_capacity", "label": "Legal standing & authorization", "signals": ["legal standing", "authorized", "legal capacity", "hereby authorize"]},
        {"id": "membership", "label": "Membership or roster", "signals": ["membership list", "member list", "roster", "members"]},
        {"id": "governance_docs", "label": "Governance documents", "signals": ["bylaws", "articles of", "organization structure", "board"]},
    ],
    "phase1-stakeholders": [
        {"id": "consultation", "label": "Stakeholder consultation record", "signals": ["stakeholder", "consultation", "public hearing", "community"]},
        {"id": "minutes", "label": "Meeting minutes or resolutions", "signals": ["meeting minutes", "minutes of", "resolution"]},
        {"id": "consensus", "label": "Consensus / agreement", "signals": ["consensus", "unanimous", "agreed", "support"]},
        {"id": "governance", "label": "Governing board involvement", "signals": ["governance board", "governing board", "board of directors"]},
    ],
    "phase2-mop": [
        {"id": "gi_name_goods", "label": "GI name & goods description (Rule 10 / MoS)", "signals": ["manual of specifications", "code of practice", "lipa barako", "geographical indication"]},
        {"id": "geo_delimitation", "label": "Delimited geographical area", "signals": ["geographical area", "territorial boundar", "lipa city", "barangay", "delimited"]},
        {"id": "causal_link", "label": "Causal link (quality ↔ origin)", "signals": ["causal link", "essentially attributable", "reputation", "characteristic"]},
        {"id": "production_qc", "label": "Production process & quality control", "signals": ["production process", "quality control", "processing", "harvest", "roasting"]},
        {"id": "labeling", "label": "Labeling & traceability rules", "signals": ["labeling", "labelling", "packaging", "traceability", "grading"]},
    ],
    "phase2-cert": [
        {"id": "gov_cert", "label": "Government agency certification", "signals": ["government certification", "department of agriculture", "lgu", "municipal", "city of lipa"]},
        {"id": "technical_validation", "label": "Technical validation of specifications", "signals": ["technical validation", "validated", "certified by", "technical certification"]},
        {"id": "independent_body", "label": "Independent verification", "signals": ["independent", "third party", "equivalent independent", "verification"]},
        {"id": "causal_confirmation", "label": "Causal link confirmation in certification", "signals": ["causal link", "geographical origin", "accuracy of the information"]},
    ],
    "phase2-details": [
        {"id": "application_form", "label": "Application form completeness", "signals": ["application form", "duly accomplished", "application to register"]},
        {"id": "applicant_identity", "label": "Applicant name & domicile", "signals": ["applicant name", "domicile", "address", "name of applicant"]},
        {"id": "establishment", "label": "Industrial / commercial establishment", "signals": ["industrial establishment", "commercial establishment", "place of business"]},
        {"id": "representation", "label": "Representative designation (if applicable)", "signals": ["representative", "designation", "authorized representative"]},
    ],
    "phase3-filing": [
        {"id": "filing_act", "label": "Filing / submission act", "signals": ["file application", "filing", "submitted", "submission"]},
        {"id": "bot_routing", "label": "Bureau of Trademarks / IPOPHL routing", "signals": ["bureau of trademarks", "ipophl", "intellectual property office", "registrar"]},
        {"id": "package", "label": "Complete application package", "signals": ["application package", "application documents", "complete application"]},
        {"id": "cover_letter", "label": "Cover / transmittal letter", "signals": ["cover letter", "transmittal", "letter of transmittal"]},
    ],
    "phase3-payment": [
        {"id": "official_receipt", "label": "Official receipt", "signals": ["official receipt", "or number", "receipt no"]},
        {"id": "fee_payment", "label": "Application / filing fee", "signals": ["application fee", "filing fee", "registration fee"]},
        {"id": "proof_paid", "label": "Proof of payment", "signals": ["proof of payment", "paid", "payment confirmation", "bank transfer"]},
    ],
    "phase4-exam": [
        {"id": "formality", "label": "Formality examination context", "signals": ["formality examination", "formal examination", "completeness"]},
        {"id": "substantive", "label": "Substantive examination context", "signals": ["substantive examination", "substantive", "registrability"]},
        {"id": "ip_code", "label": "IP Code / RR-GI compliance", "signals": ["intellectual property code", "ip code", "8293", "rr-gi", "memorandum circular"]},
    ],
    "phase4-response": [
        {"id": "deficiency", "label": "Deficiency notice reference", "signals": ["deficiency", "deficiency notice", "notice of deficiency"]},
        {"id": "timeline", "label": "Response within timeframe", "signals": ["timeframe", "within the period", "deadline", "days from"]},
        {"id": "corrective", "label": "Corrective actions taken", "signals": ["corrective action", "amended", "remedy", "comply with"]},
    ],
    "phase4-pub": [
        {"id": "publication", "label": "Publication for opposition", "signals": ["publication", "published for opposition", "third-party observation"]},
        {"id": "notice_period", "label": "Public notice period", "signals": ["public notice", "notice period", "observation period"]},
        {"id": "opposition", "label": "Opposition period handling", "signals": ["opposition", "opposition period", "objection"]},
    ],
    "phase5-cert": [
        {"id": "gi_certificate", "label": "GI registration certificate", "signals": ["gi registration certificate", "certificate of registration", "registered geographical indication"]},
        {"id": "official_notice", "label": "Official notice of registration", "signals": ["notice of registration", "official notice"]},
        {"id": "reg_number", "label": "Registration number", "signals": ["registration number", "registration no", "reg. no", "g/"]},
    ],
    "phase5-compliance": [
        {"id": "quality_maintenance", "label": "Ongoing quality standards", "signals": ["maintain quality", "quality standards", "compliance with standards"]},
        {"id": "audits", "label": "Compliance audits / inspections", "signals": ["compliance audit", "audit", "inspection"]},
        {"id": "monitoring", "label": "Monitoring records", "signals": ["monitoring", "records", "documentation of"]},
    ],
}


def _signal_matches(text_lower: str, signal: str, term_matches: Callable[[str, str], bool]) -> bool:
    sig = signal.lower().strip()
    if not sig:
        return False
    if sig in text_lower:
        return True
    return term_matches(text_lower, sig)


def evaluate_gi_rubric(
    text_lower: str,
    task_id: str | None,
    term_matches: Callable[[str, str], bool],
) -> dict | None:
    """Return section rubric evaluation for a task, or None if no rubric defined."""
    if not task_id or task_id not in TASK_RUBRICS:
        return None

    sections_out: list[dict] = []
    found_count = 0
    for section in TASK_RUBRICS[task_id]:
        signals = section.get("signals") or []
        found = any(_signal_matches(text_lower, s, term_matches) for s in signals)
        if found:
            found_count += 1
        sections_out.append(
            {
                "id": section["id"],
                "label": section["label"],
                "found": found,
            }
        )

    total = max(1, len(sections_out))
    section_score = min(100, round((found_count / total) * 100))
    return {
        "task_id": task_id,
        "sections": sections_out,
        "sections_found": found_count,
        "sections_total": total,
        "section_score": section_score,
    }


def build_term_breakdown(
    checklist: dict,
    detected_mandatory: list[str],
    detected_optional: list[str],
) -> list[dict]:
    """Auditable per-term point contributions for the keyword formula."""
    mandatory_terms = checklist.get("mandatory_terms") or []
    optional_terms = checklist.get("optional_terms") or []
    m_total = max(1, len(mandatory_terms))
    o_total = max(1, len(optional_terms)) if optional_terms else 1
    m_pts = 70 / m_total
    o_pts = (30 / o_total) if optional_terms else 0

    rows: list[dict] = []
    for term in mandatory_terms:
        found = term in detected_mandatory
        rows.append(
            {
                "term": term,
                "type": "mandatory",
                "found": found,
                "points": round(m_pts if found else 0, 1),
                "max_points": round(m_pts, 1),
            }
        )
    for term in optional_terms:
        found = term in detected_optional
        rows.append(
            {
                "term": term,
                "type": "optional",
                "found": found,
                "points": round(o_pts if found else 0, 1),
                "max_points": round(o_pts, 1),
            }
        )
    return rows


def blend_scores(keyword_score: int, rubric: dict | None, *, all_mandatory_found: bool) -> int:
    """
    When all mandatory keywords match, keyword score stays authoritative.
    Otherwise blend keyword (65%) with section rubric (35%).
    """
    if not rubric:
        return keyword_score
    if all_mandatory_found:
        return keyword_score
    section_score = int(rubric.get("section_score") or 0)
    return min(100, round(0.65 * keyword_score + 0.35 * section_score))
