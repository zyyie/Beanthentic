import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "machinelearning"))
sys.path.insert(0, str(ROOT))

from ai_engine import GIAnalyzer

a = GIAnalyzer()
print("Model loaded:", a.document_model is not None)
status = a.ml_status()
print(f"Training CV: {status.get('training', {})}")

tests = [
    (
        "phase1-introduction ready",
        "phase1-introduction",
        """
        Kapeng Barako Liberica from Batangas has a strong reputation as a
        geographical indication product. Coffea liberica is distinctive and
        known for tradition and origin in Lipa.
        """,
    ),
    (
        "phase1-introduction incomplete",
        "phase1-introduction",
        "We grow coffee in Philippines. Good taste.",
    ),
    (
        "phase3-control ready",
        "phase3-control",
        """
        Internal control requires growers registered with BaCoFFed
        (Batangas Coffee Farmers Federation). Traceability records are kept
        with the Provincial Technical Working Group under the Code of Practice.
        LGU certificate of locality and batch/lot records are maintained.
        """,
    ),
]

tmp = Path("machinelearning/uploads/_verify_ml.txt")
for name, task, text in tests:
    tmp.write_text(text.strip(), encoding="utf-8")
    r = a.analyze_document(str(tmp), task_id=task)
    print(
        f"{name}: score={r['readiness_score']} status={r['status']} "
        f"rule={r.get('rule_score')} ml={r.get('ml_score')}"
    )
tmp.unlink(missing_ok=True)
