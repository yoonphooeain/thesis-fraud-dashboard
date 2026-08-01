# NexaGift Explainable AI Fraud Prototype

NexaGift is a local master-thesis prototype for detecting account takeover
(ATO) and fraudulent digital gift-card transactions before simulated code
delivery. It combines a trained fraud model, SHAP evidence, a policy-based risk
engine, OTP verification, manual review, blocking, and an audit trail.

All records, credentials, OTP values, payment data, and gift-card codes are
synthetic or simulated. This project is not a production payment system.

## Implemented System

- React customer storefront, checkout, OTP flow, and admin security dashboard
- 20,000-row reproducible synthetic dataset with 33 documented columns
- Chronological 14,000/3,000/3,000 train, validation, and locked-test splits
- Logistic Regression, Random Forest, and XGBoost comparison
- Class weighting and validation-only threshold selection
- PR-AUC, Recall, Precision, F1, MCC, FPR, confusion matrix, and latency results
- Global and local SHAP artifacts
- Risk score mapped to Allow, OTP Required, Manual Review, or Block
- FastAPI prediction, authentication, OTP, review, transaction, and audit APIs
- SQLite research-prototype persistence
- Frontend fallback simulation when the API is unavailable

## Verified Experiment

The current seeded synthetic experiment selected Random Forest by validation
PR-AUC, then Recall, then lower FPR. Its locked-test results are loaded directly
by the Model Evaluation dashboard:

- PR-AUC: 0.9988
- Precision: 0.9831
- Recall: 0.9831
- F1: 0.9831
- MCC: 0.9824
- False positives: 2
- False negatives: 2
- Decision threshold: 0.4491

These high values reflect a controlled synthetic dataset. They must be reported
as synthetic experimental results, not evidence of production performance.

## First-Time Setup

Node.js `>=22.13.0`, Python 3.12+, `curl`, `unzip`, and `zstd` are required.
The source Excel workbook is expected at:

`~/Desktop/Ai thesis/NexaGift_20K_Synthetic_Fraud_Dataset.xlsx`

Run:

```bash
npm install
./scripts/setup_backend.sh
```

The setup script installs the isolated Python environment, exports and validates
the Excel dataset, trains all three models, creates SHAP/evaluation artifacts,
and runs backend tests. On Apple Silicon it can install a project-local OpenMP
runtime when Homebrew `libomp` is unavailable.

## Run Locally

Start both API and website:

```bash
./scripts/start_local.sh
```

Open:

- Website: [http://127.0.0.1:3000](http://127.0.0.1:3000)
- API documentation: [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs)
- API health: [http://127.0.0.1:8000/health](http://127.0.0.1:8000/health)

To run them in separate terminals:

```bash
./scripts/run_backend.sh
npm run dev
```

## Live Demo on GitHub Pages

This repository is prepared for GitHub Pages deployment from the `docs/` folder.
After the project is pushed to GitHub, enable Pages with **Source: Deploy from a
branch**, then select **Branch: main** and **Folder: /docs**. The live website
URL will use this format:

`https://<github-username>.github.io/<repository-name>/`

Example:

`https://your-username.github.io/thesis-fraud-dashboard/`

The Pages export creates a static frontend demo from the current multi-page UI and
rewrites CSS, image, and route paths so the site works under the GitHub Pages
repository base path. GitHub Pages cannot run the local FastAPI/Python backend,
so the online demo uses the frontend's local thesis inference fallback when the
trained model API is unavailable. For the full trained-model API demo, run the
project locally with `./scripts/start_local.sh`.

To build the GitHub Pages artifact locally:

```bash
npm run export:github-pages
```

The generated static site is written to `docs/`.

## Local Admin

The local-only default account is:

- Username: `admin`
- Password: `NexaGift-Local-Admin-2026`

Override it before first database creation:

```bash
export NEXAGIFT_ADMIN_USERNAME="your-admin"
export NEXAGIFT_ADMIN_PASSWORD="a-strong-local-password"
export NEXAGIFT_OTP_SECRET="a-random-local-secret"
```

## Verification

```bash
bash -c 'source scripts/backend_env.sh && cd backend && .venv/bin/pytest -q'
npm run lint
npm test
```

## Research Integrity

- The full dataset and every split are checked for missing values and duplicate
  transaction identifiers.
- Rows are sorted chronologically and train/validation/test boundaries cannot
  overlap.
- Preprocessing, class weighting, model selection, and threshold tuning use
  training/validation data only.
- The locked test set is evaluated after model selection.
- The UI identifies the environment and results as synthetic research.
- Simulated codes are non-redeemable and are released only after Allow,
  successful OTP, or administrator approval.

## Interface References

The admin composition adapts public interface patterns from
[21st.dev Admin Panel](https://21st.dev/community/components/s/admin-panel),
[21st.dev Dashboard](https://21st.dev/community/components/s/dashboard), and
[21st.dev Fraud Card](https://21st.dev/community/components/forge-ui/fraud-card/default).
