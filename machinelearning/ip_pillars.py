"""
IPOPHL four-pillar standard for GI document requirement analysis.

The analyzer classifies every requirement under:
  Trademark | Copyright | Industrial Design | Patent

This is the identification standard — not a loose keyword list.
"""

from __future__ import annotations

from typing import Callable

PILLAR_ORDER = ("trademark", "copyright", "industrial_design", "patent")

IP_PILLARS: dict[str, dict] = {
    "trademark": {
        "label": "Trademark",
        "scope": (
            "Geographical indications, signs, labels, product names, branding, "
            "filing with the Bureau of Trademarks, publication, opposition, and GI registration."
        ),
        "signals": [
            "geographical indication",
            " gi ",
            "trademark",
            "bureau of trademarks",
            "intellectual property office",
            "ipophl",
            "labeling",
            "labelling",
            "brand",
            "trade mark",
            "product name",
            "opposition",
            "publication",
            "registrability",
            "application to register",
            "certificate of registration",
            "lipa barako",
            "kapeng barako",
            "barako",
            "distinctive quality",
            "geographical origin",
            "flavor profile",
        ],
    },
    "copyright": {
        "label": "Copyright",
        "scope": (
            "Original literary and artistic works: manuals, specifications, codes of practice, "
            "descriptive text, consultation records, letters, and authored documentation."
        ),
        "signals": [
            "copyright",
            "manual of specifications",
            "manual of specification",
            "code of practice",
            "mop",
            "specifications manual",
            "meeting minutes",
            "cover letter",
            "transmittal",
            "stakeholder consultation",
            "written description",
            "authored",
            "literary",
            "artistic work",
            "original work",
            "product description",
            "narrative",
        ],
    },
    "industrial_design": {
        "label": "Industrial Design",
        "scope": (
            "Ornamental or aesthetic appearance of products and packaging: label layout, "
            "product imagery, visual presentation, and design of goods or containers."
        ),
        "signals": [
            "industrial design",
            "design registration",
            "ornamental",
            "aesthetic",
            "appearance of",
            "packaging design",
            "label design",
            "product photo",
            "product image",
            "product photograph",
            "visual presentation",
            "packaging",
            "container design",
            "logo design",
            "get-up",
        ],
    },
    "patent": {
        "label": "Patent",
        "scope": (
            "Technical processes, methods, and inventive steps: production, processing, "
            "quality-control systems, and novel apparatus or methods described in the filing."
        ),
        "signals": [
            "patent",
            "utility model",
            "invention",
            "inventive step",
            "technical solution",
            "production process",
            "processing method",
            "processing steps",
            "quality control",
            "roasting process",
            "farming practices",
            "post-harvest",
            "technical validation",
            "apparatus",
            "method comprising",
        ],
    },
}

# Checklist / rubric labels → pillar (standard mapping for Kapeng Barako GI uploads)
TERM_PILLAR_MAP: dict[str, str] = {
    # Trademark
    "lipa barako coffee": "trademark",
    "geographical origin": "trademark",
    "distinctive quality": "trademark",
    "flavor profile": "trademark",
    "labeling rules": "trademark",
    "bureau of trademarks": "trademark",
    "file application": "trademark",
    "application package": "trademark",
    "cover letter": "copyright",
    "publication for opposition": "trademark",
    "public notice period": "trademark",
    "opposition period": "trademark",
    "gi registration certificate": "trademark",
    "official notice of registration": "trademark",
    "registration number": "trademark",
    "application form": "trademark",
    "applicant name": "trademark",
    "applicant entity": "trademark",
    "domicile": "trademark",
    "formality examination": "trademark",
    "substantive examination": "trademark",
    "ip code compliance": "trademark",
    "deficiency notice response": "trademark",
    "aroma": "trademark",
    # Copyright
    "manual of specifications": "copyright",
    "stakeholder consultations": "copyright",
    "meeting minutes": "copyright",
    "consensus": "copyright",
    "governance board": "copyright",
    "causal link": "copyright",
    "geographical area": "copyright",
    "territorial boundaries": "copyright",
    "maintain quality standards": "copyright",
    "monitoring records": "copyright",
    # Industrial design
    "product photos": "industrial_design",
    "packaging": "industrial_design",
    # Patent / technical
    "production process": "patent",
    "quality control": "patent",
    "roasting process": "patent",
    "farming practices": "patent",
    "technical validation": "patent",
    "government certification": "patent",
    "independent verification": "patent",
    "industrial establishment": "patent",
    "regular compliance audits": "patent",
    "official receipt": "patent",
    "application fee": "patent",
    "proof of payment": "patent",
    "producers organization": "trademark",
    "legal standing": "trademark",
    "membership list": "copyright",
    "timeframe compliance": "trademark",
    "corrective actions": "patent",
}


def _norm(s: str) -> str:
    return " ".join(str(s or "").lower().split())


def pillar_for_term(term: str) -> str:
    key = _norm(term)
    if key in TERM_PILLAR_MAP:
        return TERM_PILLAR_MAP[key]
    if any(w in key for w in ("label", "brand", "gi", "trademark", "opposition", "publication", "registration")):
        return "trademark"
    if any(w in key for w in ("manual", "minute", "consultation", "letter", "specification", "practice")):
        return "copyright"
    if any(w in key for w in ("photo", "image", "packaging", "design", "visual", "appearance")):
        return "industrial_design"
    if any(w in key for w in ("process", "production", "quality", "technical", "patent", "method", "audit", "fee", "receipt")):
        return "patent"
    return "trademark"


def _pillar_signal_hit(text_lower: str, pillar_id: str, term_matches: Callable[[str, str], bool]) -> bool:
    meta = IP_PILLARS.get(pillar_id) or {}
    for signal in meta.get("signals") or []:
        sig = signal.lower().strip()
        if not sig:
            continue
        if sig in text_lower:
            return True
        if term_matches(text_lower, sig):
            return True
    return False


def _pillar_status(met: list[str], gaps: list[str], signal_hit: bool) -> str:
    if met and not gaps:
        return "addressed"
    if met and gaps:
        return "partial"
    if gaps:
        return "not_addressed"
    if signal_hit:
        return "partial"
    return "not_addressed"


TASK_DOC_LABELS: dict[str, str] = {
    "phase1-product": "Qualifying Product identification",
    "phase1-entity": "Applicant Entity documentation",
    "phase1-stakeholders": "Stakeholder Consultation records",
    "phase2-mop": "Manual of Specifications (MoP)",
    "phase2-cert": "Certifications and Proofs",
    "phase2-details": "Application Form and Details",
    "phase3-filing": "Application Filing package",
    "phase3-payment": "Proof of Payment",
    "phase4-exam": "Formality and Substantive Examination",
    "phase4-response": "Deficiency Notice Response",
    "phase4-pub": "Publication for Opposition",
    "phase5-cert": "GI Registration Certificate",
    "phase5-compliance": "Standards and Quality Control",
}


def _snippet_around(text: str, keyword: str, radius: int = 140) -> str:
    """Return a short excerpt from the document around a matched term."""
    if not text or not keyword:
        return ""
    low = text.lower()
    key = keyword.lower().strip()
    idx = low.find(key)
    if idx < 0:
        return ""
    start = max(0, idx - radius)
    end = min(len(text), idx + len(key) + radius)
    snippet = " ".join(text[start:end].split())
    if start > 0:
        snippet = "…" + snippet
    if end < len(text):
        snippet = snippet + "…"
    return snippet[:320]


def _collect_pillar_evidence(text: str, pillar_id: str, met: list[str], matches) -> list[str]:
    """Pull document excerpts that support a pillar assessment."""
    evidence: list[str] = []
    for term in met[:3]:
        snip = _snippet_around(text, term)
        if snip and snip not in evidence:
            evidence.append(snip)
    meta = IP_PILLARS.get(pillar_id) or {}
    if len(evidence) < 2:
        for signal in (meta.get("signals") or [])[:6]:
            sig = str(signal).strip()
            if not sig:
                continue
            if sig.lower() in text.lower() or matches(text.lower(), sig):
                snip = _snippet_around(text, sig)
                if snip and snip not in evidence:
                    evidence.append(snip)
            if len(evidence) >= 2:
                break
    return evidence[:2]


def _document_insights(
    text: str,
    *,
    detected_features: list[str],
    missing_requirements: list[str],
    rubric_sections: list[dict] | None,
    task_id: str | None,
    text_length: int = 0,
    mandatory_met: int | None = None,
    mandatory_total: int | None = None,
) -> dict:
    words = len(text.split()) if text else 0
    sections = rubric_sections or []
    found_sections = [s.get("label") for s in sections if s.get("found") and s.get("label")]
    missing_sections = [s.get("label") for s in sections if not s.get("found") and s.get("label")]
    doc_label = TASK_DOC_LABELS.get(task_id or "", "GI supporting document")
    met = mandatory_met if mandatory_met is not None else len(detected_features or [])
    total = mandatory_total if mandatory_total is not None else met + len(missing_requirements or [])
    return {
        "document_type": doc_label,
        "word_count": words,
        "text_length": text_length or len(text),
        "checklist_met": met,
        "checklist_total": total,
        "sections_found": found_sections,
        "sections_missing": missing_sections,
        "detected_features": list(dict.fromkeys(detected_features or []))[:12],
        "missing_requirements": list(dict.fromkeys(missing_requirements or []))[:12],
    }


def _format_list(items: list[str], limit: int = 4) -> str:
    clean = [str(i).strip() for i in items if str(i).strip()]
    if not clean:
        return ""
    shown = clean[:limit]
    text = ", ".join(shown)
    if len(clean) > limit:
        text += f", and {len(clean) - limit} more"
    return text


def _pillar_narrative(pillar: dict) -> str:
    label = pillar.get("label") or "Pillar"
    status = pillar.get("status") or "not_addressed"
    met = pillar.get("met") or []
    gaps = pillar.get("gaps") or []
    scope = pillar.get("scope") or ""
    evidence = pillar.get("evidence") or []
    scope_plain = scope.lower().rstrip(".")

    if status == "addressed":
        parts = [
            f"{label} — Addressed. This upload provides clear support for the {label} pillar under the IPOPHL four-pillar Geographical Indication framework.",
            f"The following requirements were identified in the submitted text: {_format_list(met, 8)}.",
        ]
        if evidence:
            parts.append(
                f"Relevant passages from the document include: {evidence[0]}"
            )
            if len(evidence) > 1:
                parts.append(f"Further supporting language was found where the file states: {evidence[1]}")
        parts.append(
            f"For Kapeng Barako / Lipa Barako GI registration, this satisfies examiner expectations for {scope_plain}. "
            f"No immediate revision is required for this pillar in this specific upload."
        )
        return " ".join(parts)

    if status == "partial":
        parts = [
            f"{label} — Partially addressed. The document references {label}-related content, "
            f"but the evidence is not yet complete enough for this filing stage.",
        ]
        if met:
            parts.append(f"Items already present: {_format_list(met, 6)}.")
        if evidence:
            parts.append(f"The submission includes related wording such as: {evidence[0]}")
        if gaps:
            parts.append(
                f"However, the following checklist items still need explicit coverage: {_format_list(gaps, 6)}. "
                f"IPOPHL formality and substantive examination typically require these to be stated clearly, "
                f"not merely implied."
            )
        parts.append(
            f"To strengthen the {label} pillar, expand sections that document {scope_plain} "
            f"using consistent Kapeng Barako terminology and task-specific IPOPHL language."
        )
        return " ".join(parts)

    if pillar.get("signal_detected"):
        parts = [
            f"{label} — Incomplete. The file contains language that suggests {label} relevance, "
            f"but mandatory checklist requirements for this pillar are not fully demonstrated.",
        ]
        if evidence:
            parts.append(f"Related text was detected: {evidence[0]}")
        if gaps:
            parts.append(
                f"Missing or undocumented items include: {_format_list(gaps, 6)}. "
                f"Examiners at the Bureau of Trademarks expect these to appear in structured, auditable form."
            )
        parts.append(
            f"Add dedicated sections covering {scope_plain}. Cross-reference the Manual of Specifications, "
            f"supporting annexes, and any labels or process descriptions that belong to this pillar."
        )
        return " ".join(parts)

    parts = [
        f"{label} — Not addressed. This upload does not yet contain sufficient documented support for the {label} pillar.",
    ]
    if gaps:
        parts.append(f"Required items not found in the extracted text: {_format_list(gaps, 6)}.")
    parts.append(
        f"IPOPHL GI examiners will look for explicit evidence of {scope_plain}. "
        f"Without this, the document may receive deficiency notices during formality or substantive review. "
        f"Revise the file to include pillar-specific content before proceeding to Complete Registration."
    )
    return " ".join(parts)


def _build_recommendations(pillars: list[dict], *, document_ready: bool) -> list[str]:
    recs: list[str] = []
    for pillar in pillars:
        gaps = pillar.get("gaps") or []
        label = pillar.get("label") or "Pillar"
        if not gaps:
            continue
        if pillar.get("id") == "trademark":
            recs.append(
                f"Trademark pillar: Strengthen geographical indication and branding content by explicitly naming "
                f"Kapeng Barako or Lipa Barako, the geographical origin (Lipa City, Batangas), distinctive quality, "
                f"flavor profile, and labeling rules. Priority gaps in this file: {_format_list(gaps, 5)}."
            )
        elif pillar.get("id") == "copyright":
            recs.append(
                f"Copyright pillar: Expand authored documentation — complete Manual of Specifications sections, "
                f"causal link narrative, stakeholder consultation records, and any cover letters or transmittals. "
                f"Address: {_format_list(gaps, 5)}."
            )
        elif pillar.get("id") == "industrial_design":
            recs.append(
                f"Industrial Design pillar: Attach or describe product imagery, packaging layouts, label design, "
                f"and visual presentation of the goods. Missing elements: {_format_list(gaps, 5)}."
            )
        else:
            recs.append(
                f"Patent / technical pillar: Document production and processing methods step-by-step, including "
                f"quality control, post-harvest handling, roasting or processing parameters, and technical validation "
                f"where applicable. Gaps to close: {_format_list(gaps, 5)}."
            )
    if document_ready:
        recs.append(
            "This file meets the current phase checklist based on extracted text. Before Complete Registration, "
            "verify that companion uploads in other IPOPHL phases cover any pillar not fully addressed in this "
            "document alone, so the full GI package collectively satisfies Trademark, Copyright, Industrial Design, "
            "and Patent requirements."
        )
    else:
        recs.append(
            "After revising this document, run Refresh Analysis so the four-pillar assessment and checklist "
            "detection update from the new text. Proceed to the next IPOPHL phase only when mandatory items "
            "for this upload category are explicitly present."
        )
    return recs[:8]


def _executive_summary(
    pillars: list[dict],
    *,
    ready_pillars: int,
    partial_pillars: int,
    gap_pillars: int,
    document_ready: bool,
    task_id: str | None = None,
) -> str:
    doc_label = TASK_DOC_LABELS.get(task_id or "", "this GI supporting document")
    status_line = (
        "Based on extracted text, this upload is Ready for its current IPOPHL phase and may proceed "
        "subject to review of companion documents in the full GI package."
        if document_ready
        else "Based on extracted text, this upload is Not Ready — one or more mandatory requirements "
        "or structural elements are missing or only partially documented."
    )
    pillar_line = (
        f"Four-pillar breakdown: {ready_pillars} pillar(s) fully addressed, {partial_pillars} partially "
        f"addressed, and {gap_pillars} requiring substantive revision, measured against Trademark, Copyright, "
        f"Industrial Design, and Patent standards used in IPOPHL GI examination."
    )
    weak = [p["label"] for p in pillars if p.get("status") != "addressed"]
    focus = ""
    if weak:
        focus = (
            f" The analysis prioritizes {', '.join(weak[:3])} for revision because these pillars show "
            f"the largest gap between submitted content and phase-specific checklist expectations."
        )
    return (
        f"This review evaluates your {doc_label} under the IPOPHL four-pillar standard applied to "
        f"Kapeng Barako / Lipa Barako Geographical Indication registration. {status_line} {pillar_line}{focus} "
        f"The sections below summarize what was detected in the uploaded file, what is missing, and "
        f"pillar-by-pillar findings drawn from the document text itself."
    )


def evaluate_ip_pillars(
    text_lower: str,
    *,
    detected_features: list[str] | None = None,
    missing_requirements: list[str] | None = None,
    rubric_sections: list[dict] | None = None,
    term_matches: Callable[[str, str], bool] | None = None,
    task_id: str | None = None,
    document_ready: bool = False,
    source_text: str | None = None,
    text_length: int = 0,
    mandatory_met: int | None = None,
    mandatory_total: int | None = None,
) -> dict:
    """
    Classify document requirements under the four IPOPHL pillars.
    Returns { pillars: [...], ready_pillars, partial_pillars, gap_pillars }.
    """
    matches = term_matches or (lambda text, term: term.lower() in text)
    raw_text = source_text or text_lower

    met_by: dict[str, list[str]] = {p: [] for p in PILLAR_ORDER}
    gap_by: dict[str, list[str]] = {p: [] for p in PILLAR_ORDER}

    for term in detected_features or []:
        t = str(term).strip()
        if not t:
            continue
        met_by[pillar_for_term(t)].append(t)

    for term in missing_requirements or []:
        t = str(term).strip()
        if not t:
            continue
        gap_by[pillar_for_term(t)].append(t)

    for section in rubric_sections or []:
        label = str(section.get("label") or "").strip()
        if not label:
            continue
        pid = pillar_for_term(label)
        if section.get("found"):
            if label not in met_by[pid]:
                met_by[pid].append(label)
        else:
            if label not in gap_by[pid]:
                gap_by[pid].append(label)

    pillars_out: list[dict] = []
    ready_count = 0
    partial_count = 0
    gap_count = 0

    for pid in PILLAR_ORDER:
        meta = IP_PILLARS[pid]
        met = list(dict.fromkeys(met_by[pid]))
        gaps = [g for g in dict.fromkeys(gap_by[pid]) if g not in met]
        signal_hit = _pillar_signal_hit(text_lower, pid, matches)
        status = _pillar_status(met, gaps, signal_hit)

        if status == "addressed":
            ready_count += 1
        elif status == "partial":
            partial_count += 1
        else:
            gap_count += 1

        pillar_row = {
            "id": pid,
            "label": meta["label"],
            "scope": meta["scope"],
            "status": status,
            "met": met,
            "gaps": gaps,
            "signal_detected": signal_hit,
            "evidence": _collect_pillar_evidence(raw_text, pid, met, matches),
        }
        pillar_row["narrative"] = _pillar_narrative(pillar_row)
        pillars_out.append(pillar_row)

    recommendations = _build_recommendations(pillars_out, document_ready=document_ready)
    executive_summary = _executive_summary(
        pillars_out,
        ready_pillars=ready_count,
        partial_pillars=partial_count,
        gap_pillars=gap_count,
        document_ready=document_ready,
        task_id=task_id,
    )
    insights = _document_insights(
        raw_text,
        detected_features=detected_features or [],
        missing_requirements=missing_requirements or [],
        rubric_sections=rubric_sections,
        task_id=task_id,
        text_length=text_length,
        mandatory_met=mandatory_met,
        mandatory_total=mandatory_total,
    )

    return {
        "pillars": pillars_out,
        "ready_pillars": ready_count,
        "partial_pillars": partial_count,
        "gap_pillars": gap_count,
        "pillar_total": len(PILLAR_ORDER),
        "executive_summary": executive_summary,
        "recommendations": recommendations,
        "document_insights": insights,
    }
