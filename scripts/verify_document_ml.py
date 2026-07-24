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
    ("phase1-product ready", "phase1-product", """
        SYNTHETIC IPOPHL SUBMISSION DOCUMENT
        Upload zone: phase1-product
        Lipa Barako coffee. Flavor Profile. Geographical Origin. Distinctive Quality.
        Product Photos. Aroma. Roasting Process. Farming Practices.
    """),
    ("phase1-product incomplete", "phase1-product", "We grow coffee in Philippines. Good taste."),
    ("phase2-mop ready", "phase2-mop", """
        Manual of Specifications. Causal Link. Production Process. Quality Control.
        Labeling Rules. Geographical Area. Lipa City Batangas Barako Coffee GI.
    """),
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
