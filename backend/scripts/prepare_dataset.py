from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
ENV_WORKBOOK = os.getenv("NEXAGIFT_XLSX")
DEFAULT_CANDIDATES = [
    *([Path(ENV_WORKBOOK)] if ENV_WORKBOOK else []),
    Path.home() / "Desktop" / "Ai thesis" / "NexaGift_20K_Synthetic_Fraud_Dataset.xlsx",
    Path.home()
    / "Documents"
    / "master thesis Ai"
    / "outputs"
    / "nexagift-excel"
    / "NexaGift_20K_Synthetic_Fraud_Dataset.xlsx",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export the NexaGift Excel workbook into reproducible CSV splits."
    )
    parser.add_argument("--workbook", type=Path)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "data")
    return parser.parse_args()


def locate_workbook(explicit: Path | None) -> Path:
    if explicit and explicit.exists():
        return explicit
    for candidate in DEFAULT_CANDIDATES:
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(
        "NexaGift workbook not found. Pass --workbook or set NEXAGIFT_XLSX."
    )


def validate_split(frame: pd.DataFrame, name: str) -> None:
    if len(frame) == 0:
        raise ValueError(f"{name} split is empty")
    if frame.isna().any().any():
        raise ValueError(f"{name} split contains missing values")
    if frame["transaction_id"].duplicated().any():
        raise ValueError(f"{name} split contains duplicate transaction IDs")
    timestamps = pd.to_datetime(frame["transaction_time"], utc=True)
    if not timestamps.is_monotonic_increasing:
        raise ValueError(f"{name} split is not chronological")


def main() -> None:
    args = parse_args()
    workbook = locate_workbook(args.workbook)
    args.output_dir.mkdir(parents=True, exist_ok=True)

    sheet_map = {
        "full": "Full Dataset",
        "train": "Training",
        "validation": "Validation",
        "test": "Testing",
    }
    frames: dict[str, pd.DataFrame] = {}
    ordering_corrections: dict[str, int] = {}
    for name, sheet in sheet_map.items():
        frame = pd.read_excel(workbook, sheet_name=sheet)
        timestamps = pd.to_datetime(frame["transaction_time"], utc=True)
        ordering_corrections[name] = int(
            (timestamps.diff().dt.total_seconds() < 0).sum()
        )
        frame = frame.assign(transaction_time=timestamps).sort_values(
            "transaction_time", kind="stable"
        ).reset_index(drop=True)
        validate_split(frame, name)
        frames[name] = frame
        frame.to_csv(args.output_dir / f"nexagift_{name}.csv", index=False)

    if [len(frames[key]) for key in ("train", "validation", "test")] != [
        14_000,
        3_000,
        3_000,
    ]:
        raise ValueError("Expected chronological 14,000/3,000/3,000 splits")
    split_bounds = [
        pd.to_datetime(frames[name]["transaction_time"], utc=True)
        for name in ("train", "validation", "test")
    ]
    if not (
        split_bounds[0].max() < split_bounds[1].min()
        and split_bounds[1].max() < split_bounds[2].min()
    ):
        raise ValueError("Chronological split boundaries overlap")

    summary = {
        "source_workbook": str(workbook),
        "dataset_type": "synthetic",
        "rows": len(frames["full"]),
        "columns": len(frames["full"].columns),
        "fraud_rate": round(float(frames["full"]["is_fraud"].mean()), 6),
        "splits": {
            name: {
                "rows": len(frame),
                "fraud_rows": int(frame["is_fraud"].sum()),
                "fraud_rate": round(float(frame["is_fraud"].mean()), 6),
            }
            for name, frame in frames.items()
        },
        "chronological": True,
        "ordering_corrections": ordering_corrections,
    }
    (args.output_dir / "dataset_summary.json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8"
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
