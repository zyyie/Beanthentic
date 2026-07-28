#!/usr/bin/env python3
"""Build official MoP CSV + RF training JSON from Part 1, Part 2, and Control files."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from machinelearning.official_mop_dataset import (  # noqa: E402
    build_official_mop_dataset,
    sync_official_mop_pipeline,
)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build official IPOPHL MoP dataset (n1–n7) and optionally train RF."
    )
    parser.add_argument("--train", action="store_true", help="Retrain gi_document_model.joblib")
    parser.add_argument("--no-augment", action="store_true", help="CSV only; skip RF negatives in JSON")
    args = parser.parse_args()

    if args.train:
        result = sync_official_mop_pipeline(ROOT, train=True)
    else:
        result = build_official_mop_dataset(ROOT, augment=not args.no_augment)

    print(f"Official MoP CSV rows: {result['csv_rows']} (Ready: {result.get('ready', 0)})")
    print(f"Training JSON rows:    {result['training_rows']}")
    print(f"CSV:  {result['csv_path']}")
    print(f"JSON: {result['json_path']}")
    if args.train:
        print(f"RF train: {'OK' if result.get('train_ok') else 'FAILED'}")
        if result.get("train_error"):
            print(result["train_error"])


if __name__ == "__main__":
    main()
