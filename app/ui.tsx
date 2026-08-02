"use client";

/* eslint-disable @next/next/no-img-element, react-hooks/set-state-in-effect, @typescript-eslint/no-unused-vars */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type CSSProperties, type FormEvent, type MouseEvent, type ReactNode } from "react";

type RiskMode = "low" | "medium" | "high";
type TransactionStatus = "email_sent" | "otp_required" | "under_review" | "blocked";
type GiftCardProduct = {
  id: string;
  categoryName: string;
  categoryClass: "gaming" | "shopping" | "entertainment";
  cardName: string;
  brand: string;
  denomination: number;
  image: string;
  availability: "available" | "low_stock";
  deliveryType: "email_code";
  codeInventory: string[];
  description: string;
};

type CheckoutDetails = {
  deliveryEmail: string;
  cardholderName: string;
  paymentCard: string;
  expiryDate: string;
  cvv: string;
  billingCountry: string;
};

type StoredTransaction = {
  id: string;
  customerEmail: string;
  giftCardId: string;
  giftCard: string;
  brand: string;
  amount: string;
  deliveryType: string;
  riskLevel: string;
  riskScore: number;
  fraudProbability: string;
  status: TransactionStatus;
  paymentCard: string;
  cardholderName?: string;
  billingCountry: string;
  deliveryChannel: "customer_email" | "held";
  updatedAt: string;
  modelName?: string;
  modelDecision?: string;
  modelThreshold?: number;
  modelSource?: string;
  shapFactors?: Array<{ feature: string; impact: string; direction: "up" | "down"; value: number }>;
};

type RiskAssessment = {
  transactionId?: string;
  risk: RiskMode;
  label: string;
  score: number;
  probability: string;
  decision: string;
  message: string;
  status: TransactionStatus;
  nextPath: string;
  reasons: string[];
  modelName?: string;
  modelDecision?: string;
  modelThreshold?: number;
  modelSource?: string;
  shapFactors?: Array<{ feature: string; impact: string; direction: "up" | "down"; value: number }>;
};

type PredictionApiResponse = {
  transaction_id: string;
  fraud_probability: number;
  model_threshold: number;
  risk_score: number;
  decision: "Allow" | "OTP Required" | "Manual Review" | "Block";
  model_name: string;
  explanation: Array<{
    feature: string;
    value: number | string;
    contribution: number;
    direction: "increase" | "decrease";
  }>;
};

type OtpChallenge = {
  transactionId: string;
  customerEmail: string;
  code: string;
  expiresAt: number;
  createdAt: string;
  attempts: number;
};

const OTP_TTL_MS = 5 * 60 * 1000;
const FRAUD_API_URL = process.env.NEXT_PUBLIC_FRAUD_API_URL ?? "http://127.0.0.1:8000";
const SITE_BASE_PATH = (process.env.NEXT_PUBLIC_SITE_BASE_PATH ?? "").replace(/\/+$/, "");
const billingCountries = ["Myanmar", "Thailand", "Singapore", "Malaysia", "United States", "Other"];

const riskProfiles: Record<RiskMode, {
  label: string;
  score: number;
  probability: string;
  decision: string;
  message: string;
  status: TransactionStatus;
  nextPath: string;
}> = {
  low: {
    label: "Low",
    score: 18,
    probability: "8.4%",
    decision: "Allow + Email Delivery",
    message: "Trusted device and normal purchase behaviour. Code will be sent by email after checkout approval.",
    status: "email_sent",
    nextPath: "/result?status=email_sent",
  },
  medium: {
    label: "Medium",
    score: 58,
    probability: "37.6%",
    decision: "OTP Required",
    message: "Some signals are unusual. OTP verification is required before email delivery.",
    status: "otp_required",
    nextPath: "/otp",
  },
  high: {
    label: "High",
    score: 84,
    probability: "76.2%",
    decision: "Pending Manual Review",
    message: "High-risk indicators detected. Gift-card code is not released and the order is held for review.",
    status: "under_review",
    nextPath: "/result?status=under_review",
  },
};

const checkoutCtaLabel: Record<RiskMode, string> = {
  low: "Approve & Send Code by Email",
  medium: "Continue to OTP Verification",
  high: "Hold for Manual Review",
};

function withBasePath(path: string) {
  if (!SITE_BASE_PATH || !path.startsWith("/")) return path;
  if (path === "/") return `${SITE_BASE_PATH}/`;
  return `${SITE_BASE_PATH}${path}`;
}

const demoStorageKeys = [
  "nexagift:customerEmail",
  "nexagift:selectedGiftCardId",
  "nexagift:lastTransaction",
  "nexagift:otpChallenge",
  "nexagift:mockOtpOutbox",
  "nexagift:mockEmailOutbox",
  "nexagift:adminSelectedTransaction",
  "nexagift:adminAuditLog",
  "nexagift:adminEmail",
];

function mapGiftCardCategory(card: GiftCardProduct) {
  if (card.categoryClass === "shopping") return "NexaShop";
  if (card.categoryClass === "entertainment") return "NexaEntertainment";
  return "NexaGame";
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function paymentDigits(value: string) {
  return value.replace(/\D/g, "");
}

function formatPaymentCard(value: string) {
  return paymentDigits(value).slice(0, 16).replace(/(\d{4})(?=\d)/g, "$1 ");
}

function formatExpiryDate(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 4);
  return digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
}

function getPaymentBrand(cardNumber: string) {
  const digits = paymentDigits(cardNumber);
  if (digits.startsWith("4")) return "VISA";
  if (/^5[1-5]/.test(digits)) return "Mastercard";
  return "Card";
}

function maskedPaymentCard(cardNumber: string) {
  const digits = paymentDigits(cardNumber);
  const last4 = digits.slice(-4) || "----";
  return `${getPaymentBrand(cardNumber)} •••• ${last4}`;
}

function isValidExpiryDate(value: string) {
  const [month, year] = value.split("/");
  const monthNumber = Number(month);
  return /^\d{2}\/\d{2}$/.test(value) && monthNumber >= 1 && monthNumber <= 12 && Number(year) >= 26;
}

function checkoutToModelFeatures(checkout: CheckoutDetails, card: GiftCardProduct) {
  const email = checkout.deliveryEmail.trim().toLowerCase();
  const billingCountry = checkout.billingCountry.trim().toLowerCase();
  const payment = checkout.paymentCard.trim().toLowerCase();
  const amountMmk = Math.round(card.denomination * 3500);
  const riskyEmail = Number(email.includes("test") || email.includes("fraud") || email.includes("temp") || email.includes("new"));
  const countryChanged = Number(Boolean(billingCountry) && billingCountry !== "myanmar");
  const trustedVisa = Number(payment.includes("visa") || paymentDigits(payment).startsWith("4"));
  const premiumAmount = Number(card.denomination >= 200);

  return {
    user_id: email ? `USR-${btoa(email).replace(/[^A-Z0-9]/gi, "").slice(0, 8).toUpperCase()}` : "USR-CHECKOUT",
    gift_card_category: mapGiftCardCategory(card),
    card_value_mmk: amountMmk,
    quantity: 1,
    total_amount_mmk: amountMmk,
    account_age_days: riskyEmail ? 9 : 420,
    account_segment: riskyEmail ? "new" : "regular",
    purchase_hour: new Date().getHours(),
    is_weekend: [0, 6].includes(new Date().getDay()) ? 1 : 0,
    new_device: riskyEmail || countryChanged ? 1 : 0,
    device_trust_score: riskyEmail || countryChanged ? 0.32 : 0.91,
    failed_login_count_24h: riskyEmail ? 4 : 0,
    ip_country_change: countryChanged,
    billing_ip_mismatch: countryChanged,
    vpn_or_proxy: countryChanged ? 1 : 0,
    impossible_travel: countryChanged && premiumAmount ? 1 : 0,
    password_changed_24h: riskyEmail,
    email_changed_24h: riskyEmail,
    delivery_email_changed: riskyEmail,
    transactions_1h: premiumAmount ? 3 : 1,
    transactions_24h: premiumAmount ? 5 : 1,
    gift_card_amount_24h_mmk: premiumAmount ? amountMmk * 2 : amountMmk,
    avg_transaction_amount_30d_mmk: 175000,
    amount_deviation_ratio: amountMmk / 175000,
    payment_method_age_days: trustedVisa ? 180 : 12,
    payment_decline_count_24h: trustedVisa ? 0 : 2,
    payment_risk_score: trustedVisa ? 0.12 : 0.46,
    has_prior_chargeback: 0,
  };
}

function assessmentFromPrediction(prediction: PredictionApiResponse): RiskAssessment {
  const risk: RiskMode = prediction.decision === "Allow"
    ? "low"
    : prediction.decision === "OTP Required"
      ? "medium"
      : "high";
  const profile = riskProfiles[risk];
  const decisionText = prediction.decision === "Allow"
    ? "Allow + Email Delivery"
    : prediction.decision === "OTP Required"
      ? "OTP Required"
      : prediction.decision === "Block"
        ? "Block / No Code Release"
        : "Pending Manual Review";
  const messageText = prediction.decision === "Allow"
    ? "The trained model found low fraud probability. The Risk Engine approved secure email delivery."
    : prediction.decision === "OTP Required"
      ? "The trained model found moderate risk. The Risk Engine requires OTP before email delivery."
      : prediction.decision === "Block"
        ? "The trained model found critical fraud evidence. The Risk Engine blocks code release."
        : "The trained model found high risk. The Risk Engine holds the order for administrator review.";
  const shapFactors = prediction.explanation.slice(0, 6).map((factor) => ({
    feature: factor.feature.replace("num__", "").replace("cat__", ""),
    impact: `${factor.contribution >= 0 ? "+" : ""}${factor.contribution.toFixed(3)}`,
    direction: factor.direction === "increase" ? "up" as const : "down" as const,
    value: Math.max(12, Math.min(92, Math.round(Math.abs(factor.contribution) * 900))),
  }));
  const topReasons = shapFactors.slice(0, 3).map((factor) => factor.feature.replaceAll("_", " "));
  return {
    ...profile,
    transactionId: prediction.transaction_id,
    risk,
    label: riskProfiles[risk].label,
    score: Math.round(prediction.risk_score),
    probability: `${(prediction.fraud_probability * 100).toFixed(1)}%`,
    decision: decisionText,
    message: `${messageText} Trained ${prediction.model_name} output was passed into the Risk Engine.`,
    reasons: [
      `trained model: ${prediction.model_name}`,
      `model decision: ${prediction.decision}`,
      ...topReasons,
    ],
    modelName: prediction.model_name,
    modelDecision: prediction.decision,
    modelThreshold: prediction.model_threshold,
    modelSource: "trained_model_api",
    shapFactors,
  };
}

function localDemoInference(checkout: CheckoutDetails, card: GiftCardProduct): RiskAssessment {
  const features = checkoutToModelFeatures(checkout, card);
  const drivers: Array<{ feature: string; contribution: number; direction: "increase" | "decrease" }> = [];
  let score = 16;

  function addDriver(feature: string, contribution: number, direction: "increase" | "decrease" = "increase") {
    drivers.push({ feature, contribution, direction });
    score += direction === "increase" ? contribution * 100 : -contribution * 45;
  }

  if (features.new_device) addDriver("new_device", 0.18);
  if (features.failed_login_count_24h > 0) addDriver("failed_login_count_24h", Math.min(0.26, features.failed_login_count_24h * 0.045));
  if (features.billing_ip_mismatch) addDriver("billing_country_mismatch", 0.16);
  if (features.vpn_or_proxy) addDriver("vpn_or_proxy", 0.1);
  if (features.amount_deviation_ratio > 2) addDriver("amount_deviation_ratio", 0.14);
  if (features.payment_decline_count_24h > 0) addDriver("payment_decline_count_24h", 0.12);
  if (features.device_trust_score >= 0.8) addDriver("trusted_device", 0.18, "decrease");
  if (features.payment_method_age_days >= 90) addDriver("established_payment_method", 0.1, "decrease");

  const clampedScore = Math.max(8, Math.min(92, Math.round(score)));
  const risk: RiskMode = clampedScore >= 70 ? "high" : clampedScore >= 35 ? "medium" : "low";
  const profile = riskProfiles[risk];
  const probability = Math.max(0.04, Math.min(0.9, clampedScore / 115));
  const positiveDrivers = drivers.filter((driver) => driver.direction === "increase");
  const shapFactors = (drivers.length ? drivers : [
    { feature: "trusted_device", contribution: 0.16, direction: "decrease" as const },
    { feature: "normal_velocity", contribution: 0.1, direction: "decrease" as const },
    { feature: "purchase_amount", contribution: 0.04, direction: "increase" as const },
  ]).slice(0, 6).map((driver) => ({
    feature: driver.feature,
    impact: `${driver.direction === "increase" ? "+" : "-"}${driver.contribution.toFixed(2)}`,
    direction: driver.direction === "increase" ? "up" as const : "down" as const,
    value: Math.max(18, Math.min(88, Math.round(driver.contribution * 260))),
  }));

  return {
    ...profile,
    transactionId: `TXN-${Date.now().toString().slice(-6)}`,
    risk,
    label: profile.label,
    score: clampedScore,
    probability: `${(probability * 100).toFixed(1)}%`,
    decision: profile.decision,
    message: `${profile.message} Local thesis inference fallback used the same checkout feature schema because the live API was not reachable.`,
    reasons: [
      "local thesis fallback: model-ready checkout features",
      positiveDrivers[0]?.feature.replaceAll("_", " ") ?? "trusted behaviour indicators",
      positiveDrivers[1]?.feature.replaceAll("_", " ") ?? "normal payment context",
      "risk engine routing applied automatically",
    ],
    modelName: "Local Demo Inference",
    modelDecision: profile.decision,
    modelThreshold: 0.5,
    modelSource: "local_demo_fallback",
    shapFactors,
  };
}

async function runTrainedModelPrediction(checkout: CheckoutDetails, card: GiftCardProduct): Promise<RiskAssessment> {
  try {
    const response = await fetch(`${FRAUD_API_URL}/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(checkoutToModelFeatures(checkout, card)),
    });
    if (!response.ok) {
      throw new Error("Prediction API error");
    }
    return assessmentFromPrediction(await response.json() as PredictionApiResponse);
  } catch {
    return localDemoInference(checkout, card);
  }
}

const giftCards: GiftCardProduct[] = [
  {
    id: "gaming-100",
    categoryName: "Gaming",
    categoryClass: "gaming",
    cardName: "Gaming Gift Card",
    brand: "NexaGift Gaming",
    denomination: 100,
    image: "/gift-card-gaming.png",
    availability: "available",
    deliveryType: "email_code",
    codeInventory: ["GAM-84K2-71P9-6A3Q", "GAM-55Q8-20RX-9T1M"],
    description: "Energetic digital game credit for game wallets, in-game items, and gaming service purchases.",
  },
  {
    id: "online-shopping-250",
    categoryName: "Online Shopping",
    categoryClass: "shopping",
    cardName: "Online Shopping Gift Card",
    brand: "NexaGift Shopping",
    denomination: 250,
    image: "/gift-card-online-shopping.png",
    availability: "available",
    deliveryType: "email_code",
    codeInventory: ["SHOP-10LX-76PA-4Q2D", "SHOP-91CA-33LP-8RM2"],
    description: "Trusted e-commerce gift credit for online checkout, digital shopping, and commercial purchase scenarios.",
  },
  {
    id: "entertainment-75",
    categoryName: "Entertainment Services",
    categoryClass: "entertainment",
    cardName: "Entertainment Services Gift Card",
    brand: "NexaGift Entertainment",
    denomination: 75,
    image: "/gift-card-entertainment.png",
    availability: "low_stock",
    deliveryType: "email_code",
    codeInventory: ["ENT-71MC-88PW-0A9B", "ENT-40KD-13TZ-8P2L"],
    description: "Premium digital media credit for streaming, movies, music, and entertainment service access.",
  },
];

const smtpReadyConfig = {
  provider: "Mailtrap or SMTP sandbox",
  host: "smtp.mailtrap.io",
  port: 2525,
  mode: "mocked for local thesis demo",
};

function safeJsonParse<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function resetDemoData() {
  if (typeof window === "undefined") return;
  demoStorageKeys.forEach((key) => localStorage.removeItem(key));
}

function ResetDemoButton({ compact = false }: { compact?: boolean }) {
  function handleReset() {
    resetDemoData();
    window.location.href = withBasePath("/");
  }

  return (
    <button className={compact ? "reset-demo-button compact" : "reset-demo-button"} onClick={handleReset} type="button">
      Reset Demo Data
    </button>
  );
}

function generateOtpCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function queueOtpChallenge(transactionId: string, customerEmail: string) {
  if (typeof window === "undefined") return null;
  const createdAt = new Date().toISOString();
  const challenge: OtpChallenge = {
    transactionId,
    customerEmail,
    code: generateOtpCode(),
    expiresAt: Date.now() + OTP_TTL_MS,
    createdAt,
    attempts: 0,
  };
  localStorage.setItem("nexagift:otpChallenge", JSON.stringify(challenge));
  localStorage.setItem("nexagift:mockOtpOutbox", JSON.stringify({
    to: customerEmail,
    subject: "Your NexaGift verification code",
    template: "otp-verification",
    otpForEmailSandboxOnly: challenge.code,
    expiresInMinutes: 5,
    smtp: smtpReadyConfig,
    queuedAt: createdAt,
  }));
  return challenge;
}

function getOtpChallenge() {
  if (typeof window === "undefined") return null;
  return safeJsonParse<OtpChallenge>(localStorage.getItem("nexagift:otpChallenge"));
}

function isOtpExpired(challenge: OtpChallenge) {
  return Date.now() > challenge.expiresAt;
}

function queueGiftCardEmail(transaction: StoredTransaction) {
  if (typeof window === "undefined") return;
  const card = giftCards.find((item) => item.id === transaction.giftCardId) ?? giftCards[0];
  const reservedCode = card.codeInventory[0] ?? "NO-CODE-AVAILABLE";
  localStorage.setItem("nexagift:mockEmailOutbox", JSON.stringify({
    to: transaction.customerEmail,
    subject: `Your ${card.cardName} is ready`,
    template: transaction.status === "email_sent" ? "gift-card-code-delivery" : "gift-card-code-delivery-after-otp",
    secureCodeToken: btoa(`${transaction.id}:${reservedCode}`),
    secureCodeForEmailSandboxOnly: reservedCode,
    giftCard: card.cardName,
    amount: transaction.amount,
    smtp: smtpReadyConfig,
    queuedAt: transaction.updatedAt,
  }));
}

function saveTransaction(
  assessment: RiskAssessment,
  card = giftCards[0],
  checkout: CheckoutDetails = {
    deliveryEmail: "",
    cardholderName: "",
    paymentCard: "",
    expiryDate: "",
    cvv: "",
    billingCountry: "Myanmar",
  },
) {
  if (typeof window === "undefined") return;

  const status = assessment.status;
  const transaction = {
    id: assessment.transactionId ?? `TXN-${Date.now().toString().slice(-6)}`,
    customerEmail: checkout.deliveryEmail,
    giftCardId: card.id,
    giftCard: card.cardName,
    brand: card.brand,
    amount: `$${card.denomination.toFixed(2)}`,
    deliveryType: card.deliveryType,
    riskLevel: assessment.label,
    riskScore: assessment.score,
    fraudProbability: assessment.probability,
    status,
    paymentCard: maskedPaymentCard(checkout.paymentCard),
    cardholderName: checkout.cardholderName,
    billingCountry: checkout.billingCountry,
    deliveryChannel: status === "email_sent" ? "customer_email" : "held",
    updatedAt: new Date().toISOString(),
    modelName: assessment.modelName,
    modelDecision: assessment.modelDecision,
    modelThreshold: assessment.modelThreshold,
    modelSource: assessment.modelSource,
    shapFactors: assessment.shapFactors,
  };

  localStorage.setItem("nexagift:lastTransaction", JSON.stringify(transaction));

  if (status === "email_sent") {
    queueGiftCardEmail(transaction);
  }

  if (status === "otp_required") {
    queueOtpChallenge(transaction.id, checkout.deliveryEmail);
  }
}

function completeOtpEmailDelivery() {
  if (typeof window === "undefined") return;

  const stored = localStorage.getItem("nexagift:lastTransaction");
  const transaction = safeJsonParse<StoredTransaction>(stored);
  const card = giftCards.find((item) => item.id === transaction?.giftCardId) ?? giftCards[0];
  const updatedTransaction: StoredTransaction = {
    ...(transaction ?? {
      id: `TXN-${Date.now().toString().slice(-6)}`,
      customerEmail: localStorage.getItem("nexagift:customerEmail") ?? "Verified customer email",
      giftCardId: card.id,
      giftCard: card.cardName,
      brand: card.brand,
      amount: `$${card.denomination.toFixed(2)}`,
      deliveryType: card.deliveryType,
      riskLevel: "Medium",
      riskScore: 58,
      fraudProbability: "37.6%",
      paymentCard: "VISA •••• 4242",
      billingCountry: "Myanmar",
      deliveryChannel: "held",
      updatedAt: new Date().toISOString(),
      status: "otp_required",
    }),
    status: "email_sent",
    deliveryChannel: "customer_email",
    updatedAt: new Date().toISOString(),
  };

  localStorage.setItem("nexagift:lastTransaction", JSON.stringify(updatedTransaction));
  localStorage.removeItem("nexagift:otpChallenge");
  queueGiftCardEmail(updatedTransaction);
}

function AppFrame({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <main className={`board-shell ${className}`}>
      <header className="board-header">
        <div className="ai-emblem">
          <span>AI</span>
        </div>
        <div>
          <h1>AI-Powered Gift Card Fraud Detection</h1>
          <p>Customer Security Flow</p>
        </div>
      </header>

      <section className="flow-board" aria-label="NexaGift customer fraud detection flow">
        {children}
      </section>
    </main>
  );
}

function AdminFrame({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <main className={`board-shell admin-shell ${className}`}>
      <header className="board-header">
        <div className="ai-emblem">
          <span>AI</span>
        </div>
        <div>
          <h1>AI-Powered Gift Card Fraud Detection</h1>
          <p>Admin Security Console</p>
        </div>
      </header>

      <section className="flow-board" aria-label="NexaGift admin fraud review flow">
        {children}
      </section>
    </main>
  );
}

type AdminTransaction = StoredTransaction & {
  modelRecommendation: string;
  scenario: string;
  shap: Array<{ feature: string; impact: string; direction: "up" | "down"; value: number }>;
};

type AuditRecord = {
  id: string;
  timestamp: string;
  action: "Allow" | "Require OTP" | "Block" | "Login" | "Review Opened";
  transactionId: string;
  customerStatus: string;
  modelResult: string;
  reason: string;
};

const fallbackAdminTransactions: AdminTransaction[] = [
  {
    id: "TXN-904271",
    customerEmail: "review.customer@nexagift.test",
    giftCardId: "online-shopping-250",
    giftCard: "Online Shopping Gift Card",
    brand: "NexaGift Shopping",
    amount: "$250.00",
    deliveryType: "email_code",
    riskLevel: "High",
    riskScore: 84,
    fraudProbability: "76.2%",
    status: "under_review",
    paymentCard: "VISA •••• 4242",
    billingCountry: "Myanmar",
    deliveryChannel: "held",
    updatedAt: new Date(Date.now() - 1000 * 60 * 8).toISOString(),
    modelRecommendation: "Manual Review",
    scenario: "Account takeover + high-value gift-card checkout",
    shap: [
      { feature: "new_device", impact: "+0.31", direction: "up", value: 82 },
      { feature: "failed_login_count_24h", impact: "+0.24", direction: "up", value: 66 },
      { feature: "amount_deviation_ratio", impact: "+0.19", direction: "up", value: 52 },
      { feature: "device_trust_score", impact: "-0.10", direction: "down", value: 30 },
    ],
  },
  {
    id: "TXN-735188",
    customerEmail: "medium.risk@nexagift.test",
    giftCardId: "gaming-100",
    giftCard: "Gaming Gift Card",
    brand: "NexaGift Gaming",
    amount: "$100.00",
    deliveryType: "email_code",
    riskLevel: "Medium",
    riskScore: 58,
    fraudProbability: "37.6%",
    status: "otp_required",
    paymentCard: "MASTER •••• 8871",
    billingCountry: "Thailand",
    deliveryChannel: "held",
    updatedAt: new Date(Date.now() - 1000 * 60 * 19).toISOString(),
    modelRecommendation: "Require OTP",
    scenario: "Unusual device with moderate purchase velocity",
    shap: [
      { feature: "vpn_or_proxy", impact: "+0.18", direction: "up", value: 48 },
      { feature: "purchase_hour", impact: "+0.12", direction: "up", value: 34 },
      { feature: "trusted_device", impact: "-0.14", direction: "down", value: 38 },
      { feature: "normal_amount", impact: "-0.08", direction: "down", value: 24 },
    ],
  },
  {
    id: "TXN-612443",
    customerEmail: "trusted.customer@nexagift.test",
    giftCardId: "entertainment-75",
    giftCard: "Entertainment Services Gift Card",
    brand: "NexaGift Entertainment",
    amount: "$75.00",
    deliveryType: "email_code",
    riskLevel: "Low",
    riskScore: 18,
    fraudProbability: "8.4%",
    status: "email_sent",
    paymentCard: "VISA •••• 1902",
    billingCountry: "Myanmar",
    deliveryChannel: "customer_email",
    updatedAt: new Date(Date.now() - 1000 * 60 * 42).toISOString(),
    modelRecommendation: "Allow",
    scenario: "Trusted device and normal purchase behaviour",
    shap: [
      { feature: "trusted_device", impact: "-0.29", direction: "down", value: 74 },
      { feature: "normal_velocity", impact: "-0.21", direction: "down", value: 58 },
      { feature: "billing_country_match", impact: "-0.12", direction: "down", value: 34 },
      { feature: "purchase_amount", impact: "+0.05", direction: "up", value: 16 },
    ],
  },
];

function formatAuditTimestamp(date = new Date()) {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

function toAdminTransaction(transaction: StoredTransaction): AdminTransaction {
  const risk = transaction.riskLevel.toLowerCase();
  return {
    ...transaction,
    modelRecommendation: transaction.modelDecision ?? (risk === "low" ? "Allow" : risk === "medium" ? "Require OTP" : "Manual Review"),
    scenario: transaction.modelSource === "trained_model_api"
      ? `Trained ${transaction.modelName ?? "ML"} model prediction routed through Risk Engine`
      : risk === "low" ? "Trusted customer checkout" : risk === "medium" ? "Additional verification required" : "High-risk code release attempt",
    shap: transaction.shapFactors?.length
      ? transaction.shapFactors
      : risk === "low"
        ? fallbackAdminTransactions[2].shap
        : risk === "medium"
          ? fallbackAdminTransactions[1].shap
          : fallbackAdminTransactions[0].shap,
  };
}

function getAdminTransactions(): AdminTransaction[] {
  if (typeof window === "undefined") return fallbackAdminTransactions;
  const stored = localStorage.getItem("nexagift:lastTransaction");
  if (!stored) return fallbackAdminTransactions;
  const transaction = safeJsonParse<StoredTransaction>(stored);
  if (!transaction) return fallbackAdminTransactions;
  const current = toAdminTransaction(transaction);
  const rest = fallbackAdminTransactions.filter((item) => item.id !== current.id);
  return [current, ...rest];
}

function getAdminStats(transactions: AdminTransaction[]) {
  const flagged = transactions.filter((item) => item.status !== "email_sent");
  const approved = transactions.filter((item) => item.status === "email_sent");
  const otpRequired = transactions.filter((item) => item.status === "otp_required");
  const blocked = transactions.filter((item) => item.status === "under_review" || item.status === "blocked");
  const predicted = transactions.filter((item) => item.riskLevel === "High" || item.riskLevel === "Medium");
  const fraudRate = transactions.length ? Math.round((predicted.length / transactions.length) * 1000) / 10 : 0;
  return { flagged, approved, otpRequired, blocked, predicted, fraudRate };
}

function getCaseStatus(transaction: AdminTransaction) {
  if (transaction.status === "blocked") return "blocked";
  if (transaction.status === "email_sent") return "resolved";
  if (transaction.status === "otp_required") return "reviewing";
  return "pending";
}

function getFlaggedReason(transaction: AdminTransaction) {
  const topDrivers = transaction.shap
    .filter((item) => item.direction === "up")
    .slice(0, 3)
    .map((item) => item.feature.replaceAll("_", " "))
    .join(", ");
  if (transaction.riskLevel === "Low") {
    return "This case is low risk because trusted-device and normal-behaviour signals reduce the fraud score.";
  }
  return `This transaction was flagged because ${topDrivers || "multiple behavioural signals"} increased the fraud risk before code delivery.`;
}

function getEvidenceIndicators(transaction: AdminTransaction) {
  return transaction.shap.slice(0, 5).map((item) => ({
    label: item.feature.replaceAll("_", " "),
    value: item.impact,
    tone: item.direction === "up" ? "increase" : "decrease",
  }));
}

function getRelatedTransactionContext(transaction: AdminTransaction) {
  const highRisk = transaction.riskLevel === "High";
  const mediumRisk = transaction.riskLevel === "Medium";
  return [
    { label: "Previous purchases", value: highRisk ? "3 gift-card attempts in 24h" : mediumRisk ? "1 recent purchase" : "Normal 30-day history" },
    { label: "Device context", value: highRisk ? "New device / low trust" : mediumRisk ? "New browser session" : "Trusted device" },
    { label: "Payment context", value: transaction.paymentCard },
    { label: "Delivery control", value: transaction.status === "email_sent" ? "Email delivery completed" : "Code delivery held" },
  ];
}

function getConfidenceLabel(transaction: AdminTransaction) {
  if (transaction.riskScore >= 75) return "High confidence";
  if (transaction.riskScore >= 45) return "Moderate confidence";
  return "Low-risk confidence";
}

function getAuditLog(): AuditRecord[] {
  if (typeof window === "undefined") return [];
  const stored = localStorage.getItem("nexagift:adminAuditLog");
  return safeJsonParse<AuditRecord[]>(stored) ?? [];
}

function appendAuditLog(record: Omit<AuditRecord, "id" | "timestamp">) {
  if (typeof window === "undefined") return;
  const nextRecord: AuditRecord = {
    ...record,
    id: `AUD-${Date.now().toString().slice(-6)}`,
    timestamp: formatAuditTimestamp(),
  };
  localStorage.setItem("nexagift:adminAuditLog", JSON.stringify([nextRecord, ...getAuditLog()].slice(0, 20)));
}

function updateCustomerFromAdmin(action: "Allow" | "Require OTP" | "Block", transaction: AdminTransaction, note: string) {
  if (typeof window === "undefined") return;
  const status: TransactionStatus = action === "Allow" ? "email_sent" : action === "Require OTP" ? "otp_required" : "blocked";
  const updatedTransaction: StoredTransaction = {
    ...transaction,
    status,
    deliveryChannel: status === "email_sent" ? "customer_email" : "held",
    updatedAt: new Date().toISOString(),
  };
  localStorage.setItem("nexagift:lastTransaction", JSON.stringify(updatedTransaction));
  localStorage.setItem("nexagift:adminSelectedTransaction", JSON.stringify(toAdminTransaction(updatedTransaction)));
  if (status === "email_sent") {
    queueGiftCardEmail(updatedTransaction);
  }
  if (status === "otp_required") {
    queueOtpChallenge(updatedTransaction.id, updatedTransaction.customerEmail);
  }
  appendAuditLog({
    action,
    transactionId: transaction.id,
    customerStatus: action === "Allow" ? "Code sent to email" : action === "Require OTP" ? "OTP required" : "Blocked / under review",
    modelResult: `${transaction.riskLevel} risk, ${transaction.fraudProbability} fraud probability`,
    reason: note,
  });
}

function DemoModePanel({ onLoad }: { onLoad?: (transaction: AdminTransaction) => void }) {
  const [message, setMessage] = useState("");

  function handleLoad(risk: RiskMode) {
    const transaction = loadDemoScenario(risk);
    if (!transaction) return;
    setMessage(`${transaction.riskLevel} scenario loaded: ${transaction.id}`);
    onLoad?.(transaction);
  }

  return (
    <div className="dashboard-card demo-mode-card">
      <div className="card-heading">
        <div>
          <h3>Demo Mode</h3>
          <small>Quickly load thesis scenarios for supervisor presentation.</small>
        </div>
        <span className="live-badge">DEMO HELPER</span>
      </div>
      <div className="demo-mode-actions">
        <button className="demo-scenario-button low" onClick={() => handleLoad("low")} type="button">Load Low</button>
        <button className="demo-scenario-button medium" onClick={() => handleLoad("medium")} type="button">Load Medium</button>
        <button className="demo-scenario-button high" onClick={() => handleLoad("high")} type="button">Load High</button>
      </div>
      <small className="demo-status-message">{message || "Loads a realistic transaction, model result, status, and audit event."}</small>
    </div>
  );
}

function getDemoScenarioTransaction(risk: RiskMode): AdminTransaction {
  const source = risk === "low"
    ? fallbackAdminTransactions[2]
    : risk === "medium"
      ? fallbackAdminTransactions[1]
      : fallbackAdminTransactions[0];
  return {
    ...source,
    id: `TXN-DEMO-${risk.toUpperCase()}-${Date.now().toString().slice(-4)}`,
    updatedAt: new Date().toISOString(),
  };
}

function loadDemoScenario(risk: RiskMode) {
  if (typeof window === "undefined") return null;
  const transaction = getDemoScenarioTransaction(risk);
  localStorage.setItem("nexagift:lastTransaction", JSON.stringify(transaction));
  localStorage.setItem("nexagift:adminSelectedTransaction", JSON.stringify(transaction));
  if (transaction.status === "email_sent") {
    queueGiftCardEmail(transaction);
  }
  if (transaction.status === "otp_required") {
    queueOtpChallenge(transaction.id, transaction.customerEmail);
  }
  appendAuditLog({
    action: "Review Opened",
    transactionId: transaction.id,
    customerStatus: `Demo ${getCaseStatus(transaction)} case loaded`,
    modelResult: `${transaction.riskLevel} risk, ${transaction.fraudProbability} fraud probability`,
    reason: `Demo Mode loaded a ${transaction.riskLevel.toLowerCase()}-risk scenario for thesis presentation.`,
  });
  return transaction;
}

export function IntroScreen() {
  const [robotTilt, setRobotTilt] = useState({ x: 0, y: 0 });

  function handleRobotMove(event: MouseEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width - 0.5;
    const y = (event.clientY - bounds.top) / bounds.height - 0.5;
    setRobotTilt({
      x: Number((-y * 9).toFixed(2)),
      y: Number((x * 11).toFixed(2)),
    });
  }

  return (
    <AppFrame>
      <Panel number="0" title="NexaGift Secure Portal" subtitle="Cinematic AI welcome gateway" className="intro-panel">
        <div className="intro-copy">
          <span className="status-pill">AI + Cybersecurity Thesis Prototype</span>
          <h2>Welcome to My Website</h2>
          <p className="intro-kicker">Intelligent access for secure digital gift-card protection.</p>
          <p>
            Step into a smart security portal where AI screens checkout behaviour, explains risky
            transactions, and protects gift-card code delivery before fraud can happen.
          </p>
          <div className="intro-feature-grid" aria-label="System capabilities">
            <span>AI Fraud Screening</span>
            <span>SHAP Evidence</span>
            <span>Risk Engine</span>
            <span>Secure Email Delivery</span>
          </div>
          <Link className="primary-button intro-cta" href={withBasePath("/login")}>
            Enter Secure Portal
          </Link>
        </div>

        <div
          className="robot-hero-visual"
          aria-hidden="true"
          onMouseMove={handleRobotMove}
          onMouseLeave={() => setRobotTilt({ x: 0, y: 0 })}
          style={{
            "--robot-tilt-x": `${robotTilt.x}deg`,
            "--robot-tilt-y": `${robotTilt.y}deg`,
          } as CSSProperties}
        >
          <div className="robot-particle-field">
            {Array.from({ length: 14 }, (_, index) => (
              <span key={index} />
            ))}
          </div>
          <div className="robot-light-ring one" />
          <div className="robot-light-ring two" />
          <div className="robot-stage">
            <div className="robot-halo" />
            <div className="robot-body">
              <div className="robot-antenna" />
              <div className="robot-head">
                <div className="robot-face">
                  <span className="robot-eye left" />
                  <span className="robot-eye right" />
                  <span className="robot-smile" />
                </div>
              </div>
              <div className="robot-neck" />
              <div className="robot-torso">
                <div className="robot-core">AI</div>
                <div className="robot-chest-lines">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
              <div className="robot-arm left">
                <span />
              </div>
              <div className="robot-arm right waving">
                <span />
              </div>
              <div className="robot-base" />
            </div>
            <div className="robot-shadow" />
          </div>
          <div className="robot-status-card">
            <span>Smart Access Online</span>
            <h3>Detect • Explain • Protect</h3>
            <p>Robot-assisted checkout security gateway ready.</p>
          </div>
        </div>
      </Panel>
    </AppFrame>
  );
}

export function LoginScreen() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setEmail("");
    setPassword("");
  }, []);

  function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!email.trim() || !password.trim()) {
      setError("Please enter both email and password.");
      return;
    }

    localStorage.setItem("nexagift:customerEmail", email.trim());
    router.push(withBasePath("/gift-cards"));
  }

  return (
    <AppFrame>
      <Panel number="1" title="Login / Register" subtitle="Customer checkout access and administrator security review" className="login-panel">
        <div className="security-illustration" aria-hidden="true">
          <img src={withBasePath("/login-ai-security-robot.png")} alt="" />
          <p>Secure login begins the risk-aware<br />digital gift-card purchase journey.</p>
        </div>

        <div className="login-card">
          <form className="login-form" onSubmit={handleLogin} autoComplete="off">
            <h2>Customer Login</h2>
            <small>Enter your customer account details</small>
            <label>
              Email Address
              <input
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                type="email"
                name="nexagift-customer-email"
                autoComplete="off"
              />
            </label>
            <label>
              Password
              <input
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                name="nexagift-customer-password"
                autoComplete="new-password"
              />
            </label>
            {error ? <small className="login-error">{error}</small> : null}
            <button className="primary-button" type="submit">Login & Browse Cards</button>
            <p>New customer? <b>Create demo account</b></p>
          </form>
          <div className="divider"><span>AI</span></div>
          <div className="role-card-list">
            <h2>Select Access Role</h2>
            <small>Customer continues shopping; Admin opens the fraud review console.</small>
            <div className="role-card active">
              <span>●</span>
              <div>
                <b>Customer Access</b>
                <small>Buy gift cards securely and receive approved codes by email.</small>
              </div>
              <i>●</i>
            </div>
            <Link className="role-card role-card-link admin-entry-card" href={withBasePath("/admin")} aria-label="Open admin login">
              <span>◆</span>
              <div>
                <b>Admin Access</b>
                <small>AI checkout screening, SHAP review, Allow / OTP / Block decisions.</small>
              </div>
              <i>→</i>
            </Link>
            <ResetDemoButton />
          </div>
        </div>
      </Panel>
    </AppFrame>
  );
}

export function GiftCardSelectionScreen() {
  const router = useRouter();
  const [selectedCardId, setSelectedCardId] = useState(giftCards[0].id);
  const selectedCard = giftCards.find((card) => card.id === selectedCardId) ?? giftCards[0];

  function continueToCheckout() {
    localStorage.setItem("nexagift:selectedGiftCardId", selectedCard.id);
    router.push(withBasePath("/checkout"));
  }

  return (
    <AppFrame>
      <Panel number="2" title="Gift Card Selection" subtitle="Browse thesis gift cards before secure checkout" className="gift-selection-panel">
        <div className="gift-catalog">
          {giftCards.map((card) => (
            <button
              className={`${selectedCard.id === card.id ? "catalog-card active" : "catalog-card"} ${card.categoryClass}`}
              key={card.id}
              onClick={() => setSelectedCardId(card.id)}
              type="button"
            >
              <img src={withBasePath(card.image)} alt="" />
              <span>{card.categoryName} • {card.availability.replace("_", " ")}</span>
              <b>{card.cardName}</b>
              <small>{card.brand} • ${card.denomination} • {card.deliveryType.replace("_", " ")}</small>
            </button>
          ))}
        </div>

        <div className="selected-product-card">
          <img src={withBasePath(selectedCard.image)} alt="" />
          <div>
            <p className="status-pill">Selected Thesis Card</p>
            <h2>{selectedCard.cardName}</h2>
            <p>{selectedCard.description}</p>
            <div className="status-grid">
              <Line label="Category" value={selectedCard.categoryName} />
              <Line label="Brand" value={selectedCard.brand} />
              <Line label="Denomination" value={`$${selectedCard.denomination.toFixed(2)}`} />
              <Line label="Stock" value={selectedCard.availability.replace("_", " ")} />
              <Line label="Delivery" value="Secure email code" />
            </div>
            <button className="primary-button" onClick={continueToCheckout}>
              Continue to Checkout
            </button>
          </div>
        </div>
      </Panel>
    </AppFrame>
  );
}

export function CheckoutScreen() {
  const router = useRouter();
  const [selectedCardId, setSelectedCardId] = useState(giftCards[0].id);
  const [assessment, setAssessment] = useState<RiskAssessment | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [checkout, setCheckout] = useState<CheckoutDetails>({
    deliveryEmail: "",
    cardholderName: "",
    paymentCard: "",
    expiryDate: "",
    cvv: "",
    billingCountry: "Myanmar",
  });
  const [checkoutError, setCheckoutError] = useState("");
  const selectedCard = giftCards.find((card) => card.id === selectedCardId) ?? giftCards[0];

  useEffect(() => {
    const email = localStorage.getItem("nexagift:customerEmail");
    if (email) {
      setCheckout((current) => ({ ...current, deliveryEmail: email }));
    }
    const storedCardId = localStorage.getItem("nexagift:selectedGiftCardId");
    if (storedCardId && giftCards.some((card) => card.id === storedCardId)) {
      setSelectedCardId(storedCardId);
    }
  }, []);

  async function continueCheckout() {
    const cardNumber = paymentDigits(checkout.paymentCard);
    if (!checkout.deliveryEmail.trim() || !checkout.cardholderName.trim() || !checkout.paymentCard.trim() || !checkout.expiryDate.trim() || !checkout.cvv.trim() || !checkout.billingCountry.trim()) {
      setCheckoutError("Please complete email, cardholder name, card details, and billing country before AI checkout screening.");
      return;
    }
    if (!isValidEmail(checkout.deliveryEmail)) {
      setCheckoutError("Please enter a valid delivery email address.");
      return;
    }
    if (cardNumber.length < 12) {
      setCheckoutError("Please enter a valid payment card number.");
      return;
    }
    if (!isValidExpiryDate(checkout.expiryDate)) {
      setCheckoutError("Please enter a valid expiry date in MM/YY format.");
      return;
    }
    if (!/^\d{3,4}$/.test(checkout.cvv)) {
      setCheckoutError("Please enter a valid 3 or 4 digit CVV.");
      return;
    }
    setCheckoutError("");
    setIsChecking(true);
    const cleanCheckout = {
      deliveryEmail: checkout.deliveryEmail.trim(),
      cardholderName: checkout.cardholderName.trim(),
      paymentCard: checkout.paymentCard.trim(),
      expiryDate: checkout.expiryDate.trim(),
      cvv: checkout.cvv.trim(),
      billingCountry: checkout.billingCountry.trim(),
    };
    try {
      const modelAssessment = await runTrainedModelPrediction(cleanCheckout, selectedCard);
      setAssessment(modelAssessment);
      saveTransaction(modelAssessment, selectedCard, cleanCheckout);
      router.push(withBasePath(modelAssessment.nextPath));
    } catch {
      setCheckoutError("AI risk screening could not complete. Please check the checkout details and try again.");
    } finally {
      setIsChecking(false);
    }
  }

  return (
    <AppFrame className="scroll-page checkout-scroll-page">
      <Panel number="3" title="Customer Checkout" subtitle="Order review, payment details, and AI risk check" className="checkout-panel customer-checkout">
        <div className="checkout-steps">
          {["Gift Card", "Checkout", "AI Check", "Status"].map((step, index) => (
            <span key={step} className={index < 2 ? "done" : index === 2 ? "current" : ""}>
              <b>{index < 2 ? "✓" : index + 1}</b>
              {step}
            </span>
          ))}
        </div>

        <div className="checkout-grid customer-grid">
          <div className="checkout-stack">
            <InfoCard title="Selected Card Summary">
              <div className="selected-mini-card">
                <img src={withBasePath(selectedCard.image)} alt="" />
                <div>
                  <b>{selectedCard.cardName}</b>
                  <small>{selectedCard.categoryName} • {selectedCard.availability.replace("_", " ")}</small>
                  <span>{selectedCard.description}</span>
                </div>
              </div>
              <Line label="Quantity" value="1" />
              <Line label="Denomination" value={`$${selectedCard.denomination.toFixed(2)}`} />
              <Line label="Delivery Type" value="Secure email code" />
            </InfoCard>

            <InfoCard title="Checkout Details">
              <div className="checkout-form">
                <label>
                  Delivery Email
                  <input
                    value={checkout.deliveryEmail}
                    onChange={(event) => setCheckout({ ...checkout, deliveryEmail: event.target.value })}
                    placeholder="name@example.com"
                    type="email"
                  />
                </label>
                <label>
                  Cardholder Name
                  <input
                    value={checkout.cardholderName}
                    onChange={(event) => setCheckout({ ...checkout, cardholderName: event.target.value })}
                    placeholder="Name on card"
                  />
                </label>
                <label>
                  Billing Country
                  <select value={checkout.billingCountry} onChange={(event) => setCheckout({ ...checkout, billingCountry: event.target.value })}>
                    {billingCountries.map((country) => (
                      <option key={country} value={country}>{country}</option>
                    ))}
                  </select>
                </label>
                <label className="card-number-field">
                  Payment Card
                  <input
                    value={checkout.paymentCard}
                    inputMode="numeric"
                    onChange={(event) => setCheckout({ ...checkout, paymentCard: formatPaymentCard(event.target.value) })}
                    placeholder="4242 4242 4242 4242"
                  />
                </label>
                <label>
                  Expiry Date
                  <input
                    value={checkout.expiryDate}
                    inputMode="numeric"
                    onChange={(event) => setCheckout({ ...checkout, expiryDate: formatExpiryDate(event.target.value) })}
                    placeholder="MM/YY"
                  />
                </label>
                <label>
                  CVV
                  <input
                    value={checkout.cvv}
                    inputMode="numeric"
                    maxLength={4}
                    onChange={(event) => setCheckout({ ...checkout, cvv: event.target.value.replace(/\D/g, "").slice(0, 4) })}
                    placeholder="123"
                    type="password"
                  />
                </label>
                <Line label="Selected Card" value={selectedCard.cardName} />
                <Line label="Category" value={selectedCard.categoryName} />
                <Line label="Delivery Method" value="Email after approval" />
                <Line label="Total Amount" value={`$${selectedCard.denomination.toFixed(2)}`} />
              </div>
            </InfoCard>
          </div>

          <div className="risk-assessment">
            <h3>AI Risk Check</h3>
            <div className="auto-risk-banner" aria-label="Automated AI risk engine">
              <b>Automated screening</b>
              <span>AI model evaluates checkout signals; customer cannot choose risk level.</span>
            </div>
            <div className="risk-layout">
              <div className={`risk-ring ${assessment?.risk ?? "medium"}`}>
                <span>Risk Level</span>
                <strong>{isChecking ? "Checking" : assessment?.label ?? "Pending"}</strong>
              </div>
              <div className="risk-copy">
                <small>Risk Score</small>
                <strong>{assessment?.score ?? "--"} <em>/ 100</em></strong>
                <b className={assessment?.risk ?? "medium"}>{assessment?.decision ?? "Waiting for trained model"}</b>
                <small>Fraud Probability</small>
                <strong>{assessment?.probability ?? "--"}</strong>
              </div>
            </div>
            <div className={`warning-box ${assessment?.risk ?? "medium"}`}>
              <b>ⓘ</b>
              <span>{assessment?.message ?? "Submit checkout to send model-ready features to the trained Random Forest fraud model."}</span>
            </div>
            <div className="signal-list">
              {(assessment?.reasons ?? [
                "checkout data will be transformed into training feature schema",
                "trained model returns fraud probability",
                "risk engine maps output to Allow, OTP, or Review",
              ]).slice(0, 4).map((reason) => (
                <span key={reason}>{reason}</span>
              ))}
            </div>
            {checkoutError ? <small className="login-error form-error">{checkoutError}</small> : null}
            <div className="email-delivery-card">
              <b>Email delivery rule</b>
              <span>Approved gift-card codes are sent to the verified customer email. The code is never printed on this web page.</span>
            </div>
            <button
              className="primary-button"
              disabled={isChecking}
              onClick={continueCheckout}
              type="button"
            >
              {isChecking ? "Running Trained Model..." : assessment ? checkoutCtaLabel[assessment.risk] : "Run AI Model & Continue"}
            </button>
          </div>
        </div>
      </Panel>
    </AppFrame>
  );
}

export function OtpScreen() {
  const router = useRouter();
  const [otpDigits, setOtpDigits] = useState(["", "", "", "", "", ""]);
  const [transaction, setTransaction] = useState<StoredTransaction | null>(null);
  const [otpError, setOtpError] = useState("");
  const [otpMessage, setOtpMessage] = useState("Enter the OTP sent to your email or phone.");
  const otpCode = otpDigits.join("");

  useEffect(() => {
    const stored = safeJsonParse<StoredTransaction>(localStorage.getItem("nexagift:lastTransaction"));
    setTransaction(stored);
    if (!stored) {
      setOtpError("No active transaction found. Please start checkout again.");
      return;
    }
    if (stored.status !== "otp_required") {
      setOtpMessage("This transaction does not currently require OTP verification.");
      return;
    }
    const challenge = getOtpChallenge();
    if (!challenge || challenge.transactionId !== stored.id || isOtpExpired(challenge)) {
      queueOtpChallenge(stored.id, stored.customerEmail);
      setOtpMessage("A fresh OTP has been sent to your email or phone.");
    }
  }, []);

  function updateOtpDigit(index: number, value: string) {
    const digit = value.replace(/\D/g, "").slice(-1);
    setOtpDigits((current) => current.map((item, itemIndex) => itemIndex === index ? digit : item));
    setOtpError("");
  }

  function verifyOtp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!transaction) {
      setOtpError("No active transaction found. Please start checkout again.");
      return;
    }
    if (otpCode.length !== 6) {
      setOtpError("Please enter the complete 6-digit OTP.");
      return;
    }
    const challenge = getOtpChallenge();
    if (!challenge || challenge.transactionId !== transaction.id) {
      setOtpError("No active OTP challenge found. Please resend OTP.");
      return;
    }
    if (isOtpExpired(challenge)) {
      setOtpError("OTP expired. Please resend OTP and try again.");
      return;
    }
    if (otpCode !== challenge.code) {
      localStorage.setItem("nexagift:otpChallenge", JSON.stringify({
        ...challenge,
        attempts: challenge.attempts + 1,
      }));
      setOtpError("Invalid OTP. Please check the code and try again.");
      return;
    }
    completeOtpEmailDelivery();
    router.push(withBasePath("/result?status=email_sent&verified=otp"));
  }

  function resendOtp() {
    if (!transaction) {
      setOtpError("No active transaction found. Please start checkout again.");
      return;
    }
    queueOtpChallenge(transaction.id, transaction.customerEmail);
    setOtpDigits(["", "", "", "", "", ""]);
    setOtpError("");
    setOtpMessage("A new OTP has been sent. It expires in 5 minutes.");
  }

  function autoFillDemoOtp() {
    if (!transaction) {
      setOtpError("No active transaction found. Please start checkout again.");
      return;
    }
    const challenge = getOtpChallenge();
    if (!challenge || challenge.transactionId !== transaction.id) {
      setOtpError("No valid demo OTP exists yet. Please resend OTP first.");
      return;
    }
    if (isOtpExpired(challenge)) {
      setOtpError("Demo OTP is expired. Please resend OTP before auto-fill.");
      return;
    }
    setOtpDigits(challenge.code.split(""));
    setOtpError("");
    setOtpMessage("Demo helper filled the current OTP. Click Verify OTP to continue.");
  }

  return (
    <AppFrame>
      <Panel number="4" title="OTP Verification" subtitle="Medium-risk checkout requires customer verification" className="otp-panel">
        <div className="phone-art" aria-hidden="true">
          <div className="phone">
            <span>•••</span>
          </div>
          <div className="lock-badge">✓</div>
          <p>OTP sent to the registered phone<br />and linked customer email</p>
        </div>
        <form className="otp-card" onSubmit={verifyOtp}>
          <h2>Enter One-Time Password</h2>
          <small>{otpMessage}</small>
          <div className="otp-digits">
            {otpDigits.map((digit, index) => (
              <input
                aria-label={`OTP digit ${index + 1}`}
                inputMode="numeric"
                key={index}
                maxLength={1}
                onChange={(event) => updateOtpDigit(index, event.target.value)}
                pattern="[0-9]*"
                value={digit}
              />
            ))}
          </div>
          {otpError ? <small className="login-error form-error">{otpError}</small> : null}
          <div className="otp-helper-actions">
            <button className="resend-button" onClick={resendOtp} type="button">Resend OTP</button>
            <button className="demo-otp-button" onClick={autoFillDemoOtp} type="button">Auto-fill OTP for Demo</button>
          </div>
          <small className="demo-helper-note">Demo helper only. Verification still runs normally.</small>
          <div className="secure-note">
            <b>◆</b>
            <span>After successful OTP verification, the gift-card code will be emailed to the customer instead of displayed here.</span>
          </div>
          <button
            className="primary-button"
            disabled={otpCode.length !== 6}
            type="submit"
          >
            Verify OTP & Send Code by Email
          </button>
        </form>
      </Panel>
    </AppFrame>
  );
}

export function ResultScreen() {
  const [status, setStatus] = useState<TransactionStatus>("email_sent");
  const [transactionId, setTransactionId] = useState("TXN-98370");
  const [transaction, setTransaction] = useState<StoredTransaction | null>(null);
  const [statusMessage, setStatusMessage] = useState("");

  function refreshCustomerStatus(useUrlStatus = false) {
    const stored = localStorage.getItem("nexagift:lastTransaction");
    if (stored) {
      const savedTransaction = safeJsonParse<StoredTransaction>(stored);
      if (!savedTransaction) return;
      setTransaction(savedTransaction);
      if (savedTransaction.id) setTransactionId(savedTransaction.id);
      if (savedTransaction.status) setStatus(savedTransaction.status);
      setStatusMessage("Latest transaction status loaded.");
      return;
    }

    if (useUrlStatus) {
      const params = new URLSearchParams(window.location.search);
      const nextStatus = params.get("status") as TransactionStatus | null;
      if (nextStatus === "email_sent" || nextStatus === "otp_required" || nextStatus === "under_review" || nextStatus === "blocked") {
        setStatus(nextStatus);
      }
    }
    setStatusMessage("No active transaction found. Please complete checkout first.");
  }

  useEffect(() => {
    refreshCustomerStatus(true);
  }, []);

  const isBlocked = status === "blocked";
  const isReview = status === "under_review" || isBlocked;
  const isOtp = status === "otp_required";
  const hasTransaction = Boolean(transaction);
  const statusPill = !hasTransaction ? "No Active Transaction" : isBlocked ? "Blocked / No Code Release" : isReview ? "Pending Review" : isOtp ? "OTP Required" : "Code sent to email";
  const titleText = !hasTransaction
    ? "No Active Transaction"
    : isBlocked
      ? "Gift Card Code Was Blocked"
    : isReview
      ? "Gift Card Code Is Not Released"
      : isOtp
        ? "Verification Required Before Delivery"
        : "Gift Card Code Sent Securely";
  const bodyText = !hasTransaction
    ? "There is no customer checkout record to display yet."
    : isBlocked
      ? "The administrator blocked this transaction, so the gift-card code is not generated or delivered."
    : isReview
      ? "The AI risk engine or administrator held this transaction, so the gift-card code is not delivered."
      : isOtp
        ? "This transaction requires OTP verification before the gift-card code can be emailed."
        : "The checkout was approved and the gift-card code was delivered to the verified customer email address.";

  return (
    <AppFrame>
      <Panel number="5" title="Final Result / Status" subtitle="Customer-facing delivery outcome" className={`result-panel ${isReview ? "review" : ""}`}>
        <div className="result-hero">
          <div className={`success-orb ${isReview ? "review" : isOtp ? "otp" : ""}`}>
            <span>{!hasTransaction ? "?" : isReview ? "!" : isOtp ? "OTP" : "✓"}</span>
          </div>
          <p className={`status-pill ${isReview ? "review" : ""}`}>
            {statusPill}
          </p>
          <h2>{titleText}</h2>
          <p>{bodyText}</p>
        </div>

        <div className="result-card">
          <h3>{!hasTransaction ? "Transaction Status" : isReview ? "Review Status" : isOtp ? "Verification Status" : "Email Delivery Status"}</h3>
          <div className={`code-vault ${isReview ? "review" : ""}`}>
            <small>{isReview || !hasTransaction ? "Gift Card Code" : "Customer Email"}</small>
            <strong>{!hasTransaction ? "NO ACTIVE CHECKOUT" : isBlocked ? "BLOCKED BY ADMIN" : isReview ? "HELD FOR REVIEW" : transaction?.customerEmail ?? "Verified customer email"}</strong>
            <span>{!hasTransaction ? "No delivery job has been created" : isBlocked ? "Code release was blocked after admin review" : isOtp ? "OTP verification is required before delivery" : isReview ? "No code delivery has occurred" : "SMTP-style delivery job queued successfully"}</span>
          </div>
          <div className="status-grid">
            <Line label="Transaction ID" value={transactionId} />
            <Line label="Gift Card" value={transaction?.giftCard ?? "Online Shopping Gift Card"} />
            <Line label="Amount" value={transaction?.amount ?? "$250.00"} />
            <Line label="Delivery Method" value={isReview ? "Blocked / Held" : isOtp ? "Waiting for OTP" : "Secure Email"} />
            <Line label="Customer Status" value={!hasTransaction ? "No active transaction" : isBlocked ? "Blocked" : isReview ? "Under Review" : isOtp ? "OTP Required" : "Email Sent"} />
            <Line label="Record Storage" value="Local demo transaction store" />
          </div>
          <div className="secure-note">
            <b>◆</b>
            <span>
              {!hasTransaction
                ? "Empty state: customer must complete checkout before a transaction can be tracked."
                : isBlocked
                  ? "The audit trail stores the block decision and keeps the gift-card code unavailable."
                : isReview
                  ? "The prototype stores the risk status and waits for administrator review before delivery."
                  : isOtp
                    ? "The customer can continue to OTP verification, or check status again after an admin decision."
                    : "For this local demo, email is mocked with an SMTP-ready Mailtrap-style structure and saved in a mock outbox."}
            </span>
          </div>
          {statusMessage ? <small className="status-refresh-message">{statusMessage}</small> : null}
          <div className="result-actions">
            {isOtp && hasTransaction ? <Link className="primary-button" href={withBasePath("/otp")}>Continue OTP</Link> : <Link className="primary-button" href={withBasePath("/checkout")}>New Checkout</Link>}
            <button className="back-button" onClick={() => refreshCustomerStatus()} type="button">Check Status</button>
            <Link className="back-button" href={withBasePath("/")}>Back to Login</Link>
          </div>
        </div>
      </Panel>
    </AppFrame>
  );
}

export function AdminLoginScreen() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  function submitAdminLogin() {
    if (!email.trim() || !password.trim()) {
      setError("Please enter admin email and password.");
      return;
    }
    try {
      localStorage.setItem("nexagift:adminEmail", email.trim());
      appendAuditLog({
        action: "Login",
        transactionId: "ADMIN-SESSION",
        customerStatus: "Admin dashboard opened",
        modelResult: "Security console access",
        reason: "Administrator authenticated for fraud review workflow.",
      });
    } catch {
      // Login should still continue if local demo storage is unavailable.
    }
    router.push(withBasePath("/admin/dashboard"));
  }

  function handleAdminLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submitAdminLogin();
  }

  return (
    <AdminFrame>
      <Panel number="A1" title="Admin Login" subtitle="Secure access for fraud monitoring and manual review" className="login-panel admin-login-panel">
        <div className="security-illustration" aria-hidden="true">
          <img src={withBasePath("/login-ai-security-robot.png")} alt="" />
          <p>Administrator review protects<br />high-risk code delivery decisions.</p>
        </div>

        <div className="login-card">
          <form className="login-form" onSubmit={handleAdminLogin} autoComplete="off" noValidate>
            <h2>Admin Security Login</h2>
            <small>Enter administrator credentials</small>
            <label>
              Admin Email
              <input
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                type="email"
                name="nexagift-admin-email"
                autoComplete="off"
              />
            </label>
            <label>
              Password
              <input
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                name="nexagift-admin-password"
                autoComplete="new-password"
              />
            </label>
            {error ? <small className="login-error">{error}</small> : null}
            <button className="primary-button" onClick={submitAdminLogin} type="button">Open Admin Dashboard</button>
          </form>
          <div className="divider"><span>AI</span></div>
          <div className="role-card-list">
            <h2>Review Authority</h2>
            <small>Admin can inspect SHAP evidence and control code release.</small>
            <div className="role-card active">
              <span>◆</span>
              <div>
                <b>Manual fraud review</b>
                <small>Risky transactions are held before gift-card code delivery.</small>
              </div>
              <i>●</i>
            </div>
            <div className="role-card">
              <span>●</span>
              <div>
                <b>Audit accountability</b>
                <small>Every Allow, OTP, and Block decision is logged.</small>
              </div>
              <i>○</i>
            </div>
          </div>
        </div>
      </Panel>
    </AdminFrame>
  );
}

export function AdminDashboardScreen() {
  const [transactions, setTransactions] = useState<AdminTransaction[]>(fallbackAdminTransactions);
  const stats = getAdminStats(transactions);
  const focusedTransaction = transactions[0] ?? fallbackAdminTransactions[0];
  const transactionVolumeTrend = [
    { day: "Mon", value: 840 },
    { day: "Tue", value: 920 },
    { day: "Wed", value: 780 },
    { day: "Thu", value: 1040 },
    { day: "Fri", value: 1135 },
    { day: "Sat", value: 1280 },
    { day: "Sun", value: 1095 },
  ];
  const riskDistribution = [
    { label: "Low Risk", value: 1240, height: 72, className: "low" },
    { label: "Medium Risk", value: 382, height: 42, className: "medium" },
    { label: "High Risk", value: 117, height: 26, className: "high" },
  ];
  const outcomeBreakdown = [
    { label: "Approved", value: 68, className: "approved" },
    { label: "OTP Required", value: 22, className: "otp" },
    { label: "Blocked", value: 10, className: "blocked" },
  ];
  const topRiskFactors = [
    { label: "new_device", value: 82, className: "up" },
    { label: "failed_login_count", value: 74, className: "up" },
    { label: "billing_country_mismatch", value: 68, className: "up" },
    { label: "amount_deviation", value: 57, className: "up" },
    { label: "velocity_score", value: 49, className: "up" },
  ];

  useEffect(() => {
    setTransactions(getAdminTransactions());
  }, []);

  return (
    <AdminFrame>
      <Panel number="A2" title="Admin Dashboard" subtitle="AI insights, risky transactions, and security operations" className="admin-dashboard-panel admin-overview-panel">
        <AdminNav active="overview" />
        <div className="admin-workspace">
          <div className="metric-row premium-kpis">
            <Metric label="Total Transactions" value={String(transactions.length * 412)} trend="+18.4% monitored volume" />
            <Metric label="Flagged Transactions" value={String(stats.flagged.length)} trend="Requires analyst action" warn />
            <Metric label="Approved" value={String(stats.approved.length)} trend="Code sent by email" />
            <Metric label="OTP Required" value={String(stats.otpRequired.length)} trend="Verification pending" warn />
            <Metric label="Blocked / Held" value={String(stats.blocked.length)} trend="No code release" warn />
            <Metric label="Fraud Rate" value={`${stats.fraudRate}%`} trend="Synthetic thesis sample" />
          </div>

          <div className="overview-chart-grid">
            <div className="dashboard-card overview-chart-card volume-chart">
              <div className="card-heading">
                <div>
                  <h3>Transaction Volume Trend</h3>
                  <small>Daily checkout activity · last 7 days</small>
                </div>
                <span className="chart-value">7,090</span>
              </div>
              <svg viewBox="0 0 520 180" role="img" aria-label="Daily transaction volume line chart">
                {[35, 70, 105, 140].map((y) => <line key={y} x1="38" x2="506" y1={y} y2={y} />)}
                {[80, 150, 220, 290, 360, 430, 500].map((x) => <line className="grid-vertical" key={x} x1={x} x2={x} y1="24" y2="150" />)}
                <text x="8" y="38">1.3k</text>
                <text x="14" y="78">1.0k</text>
                <text x="20" y="118">700</text>
                <text x="20" y="154">400</text>
                <polyline className="line-cyan" points="50,111 125,91 200,126 275,62 350,43 425,24 500,54" />
                {transactionVolumeTrend.map((item, index) => (
                  <g key={item.day}>
                    <circle className="volume-dot" cx={50 + index * 75} cy={[111, 91, 126, 62, 43, 24, 54][index]} r="4" />
                    <text className="axis-label" x={40 + index * 75} y="174">{item.day}</text>
                  </g>
                ))}
              </svg>
              <div className="chart-legend">
                <span><i className="low" />Total checkout transactions</span>
              </div>
            </div>

            <div className="dashboard-card overview-chart-card risk-bars-card">
              <div className="card-heading">
                <div>
                  <h3>Risk Distribution</h3>
                  <small>Low / Medium / High risk counts</small>
                </div>
              </div>
              <div className="vertical-risk-bars">
                {riskDistribution.map((item) => (
                  <div className="vertical-bar" key={item.label}>
                    <strong>{item.value}</strong>
                    <i><b className={item.className} style={{ height: `${item.height}%` }} /></i>
                    <span>{item.label}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="dashboard-card overview-chart-card compact-chart-card outcome-donut-card">
              <div className="card-heading">
                <div>
                  <h3>Outcome Breakdown</h3>
                  <small>Approved / OTP / Blocked</small>
                </div>
              </div>
              <div className="donut-layout">
                <div className="donut-chart">
                  <span>90%</span>
                  <small>Released or verified</small>
                </div>
                <div className="outcome-legend">
                  {outcomeBreakdown.map((item) => (
                    <span key={item.label}><i className={item.className} />{item.label} {item.value}%</span>
                  ))}
                </div>
              </div>
            </div>

            <div className="dashboard-card overview-chart-card compact-chart-card">
              <div className="card-heading">
                <div>
                  <h3>Top Risk Factors</h3>
                  <small>Simplified SHAP-style overview</small>
                </div>
              </div>
              <div className="factor-bars">
                {topRiskFactors.map((item) => (
                  <div className="factor-row" key={item.label}>
                    <span>{item.label}</span>
                    <i><b className={item.className} style={{ width: `${item.value}%` }} /></i>
                    <em>{item.value}</em>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="admin-grid">
            <div className="dashboard-card">
              <div className="card-heading">
                <h3>Model Insight Summary</h3>
                <small>LR · RF · XGBoost + SHAP</small>
              </div>
              <div className="model-score-card">
                <strong>XGBoost</strong>
                <span>selected candidate after validation</span>
                <b>PR-AUC focus</b>
              </div>
              <div className="insight-list compact">
                <Line label="Top risk driver" value={focusedTransaction?.shap[0]?.feature ?? "new_device"} />
                <Line label="Decision layer" value="Risk Engine" />
                <Line label="Protected action" value="Code delivery" />
                <Line label="Explainability" value="SHAP evidence" />
              </div>
            </div>

            <div className="dashboard-card dataset-summary-card">
              <div className="card-heading">
                <h3>Model / Dataset Summary</h3>
                <small>Concise thesis experiment context</small>
              </div>
              <div className="insight-list compact">
                <Line label="Total records" value="20,000" />
                <Line label="Fraud ratio" value="4.5% fraud / 95.5% normal" />
                <Line label="Features" value="33 login-to-purchase signals" />
                <Line label="Model" value="LR, RF, XGBoost candidate set" />
                <Line label="Explanation" value="Global + local SHAP" />
              </div>
            </div>

            <div className="dashboard-card system-health-card">
              <div className="card-heading">
                <h3>System Health</h3>
                <small>Local thesis prototype services</small>
              </div>
              <div className="health-grid">
                <span><b>Model API</b><em>Ready</em></span>
                <span><b>Risk Engine</b><em>Active</em></span>
                <span><b>OTP Service</b><em>Sandbox</em></span>
                <span><b>Email Queue</b><em>Mock SMTP</em></span>
              </div>
            </div>

            <div className="dashboard-card alert-center">
              <div className="card-heading">
                <h3>Alert Center</h3>
                <small>Checkout-time security signals</small>
              </div>
              <div className="alert-list">
                <span className="alert critical">High risk code release attempt</span>
                <span className="alert warning">OTP queue waiting for customer verification</span>
                <span className="alert info">Low-risk approvals use email-only delivery</span>
                <span className="alert warning">Spike watch: repeated failed login signals in review queue</span>
              </div>
            </div>

            <div className="dashboard-card recent-activity-card">
              <div className="card-heading">
                <h3>Recent Admin Activity</h3>
                <small>Latest analyst operations</small>
              </div>
              <div className="activity-list">
                <span><b>Case opened</b><em>{focusedTransaction?.id ?? "TXN-904271"}</em></span>
                <span><b>SHAP reviewed</b><em>Top drivers inspected</em></span>
                <span><b>Queue status</b><em>{stats.flagged.length} flagged transaction(s)</em></span>
              </div>
            </div>
          </div>
        </div>
      </Panel>
    </AdminFrame>
  );
}

export function AdminTransactionsScreen() {
  const router = useRouter();
  const [transactions, setTransactions] = useState<AdminTransaction[]>(fallbackAdminTransactions);
  const [selectedTransaction, setSelectedTransaction] = useState<AdminTransaction>(fallbackAdminTransactions[0]);
  const [query, setQuery] = useState("");
  const [riskFilter, setRiskFilter] = useState("All");
  const [statusFilter, setStatusFilter] = useState("All");
  const [sortMode, setSortMode] = useState("Newest");
  const filteredTransactions = transactions
    .filter((item) => riskFilter === "All" || item.riskLevel === riskFilter)
    .filter((item) => statusFilter === "All" || item.status === statusFilter)
    .filter((item) => `${item.id} ${item.customerEmail} ${item.giftCard} ${item.paymentCard}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => {
      if (sortMode === "Risk score") return b.riskScore - a.riskScore;
      if (sortMode === "Fraud probability") return Number.parseFloat(b.fraudProbability) - Number.parseFloat(a.fraudProbability);
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

  useEffect(() => {
    const nextTransactions = getAdminTransactions();
    setTransactions(nextTransactions);
    setSelectedTransaction(nextTransactions[0] ?? fallbackAdminTransactions[0]);
  }, []);

  function openReview(transaction: AdminTransaction) {
    localStorage.setItem("nexagift:adminSelectedTransaction", JSON.stringify(transaction));
    appendAuditLog({
      action: "Review Opened",
      transactionId: transaction.id,
      customerStatus: transaction.status.replace("_", " "),
      modelResult: `${transaction.riskLevel} risk, ${transaction.fraudProbability}`,
      reason: "Administrator opened transaction detail for SHAP evidence review.",
    });
    router.push(withBasePath("/admin/review"));
  }

  function previewCase(transaction: AdminTransaction) {
    setSelectedTransaction(transaction);
    if (typeof window !== "undefined") {
      localStorage.setItem("nexagift:adminSelectedTransaction", JSON.stringify(transaction));
    }
  }

  return (
    <AdminFrame>
      <Panel number="A3" title="Risky Transactions" subtitle="Flagged checkouts requiring security review" className="admin-dashboard-panel">
        <AdminNav active="transactions" />
        <div className="admin-workspace">
          <div className="dashboard-card full-span">
            <div className="card-heading">
              <h3>Transaction Monitoring Queue</h3>
              <small>Open a case to review fraud probability, SHAP evidence, and response action.</small>
            </div>
            <div className="admin-controls queue-controls">
              <label>
                Search
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="TXN, email, gift card, payment" />
              </label>
              <label>
                Risk
                <select value={riskFilter} onChange={(event) => setRiskFilter(event.target.value)}>
                  <option>All</option>
                  <option>High</option>
                  <option>Medium</option>
                  <option>Low</option>
                </select>
              </label>
              <label>
                Status
                <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                  <option>All</option>
                  <option value="under_review">Under review</option>
                  <option value="blocked">Blocked</option>
                  <option value="otp_required">OTP required</option>
                  <option value="email_sent">Email sent</option>
                </select>
              </label>
              <label>
                Sort
                <select value={sortMode} onChange={(event) => setSortMode(event.target.value)}>
                  <option>Newest</option>
                  <option>Risk score</option>
                  <option>Fraud probability</option>
                </select>
              </label>
            </div>
            {!filteredTransactions.length ? (
              <div className="empty-state-card audit-empty">
                <b>No flagged transactions matched</b>
                <span>Adjust the search or filters to view pending, OTP, or resolved review cases.</span>
              </div>
            ) : null}
            <div className="transaction-management-grid">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Transaction</th>
                    <th>Customer</th>
                    <th>Gift Card</th>
                    <th>Risk</th>
                    <th>Fraud Prob.</th>
                    <th>Status</th>
                    <th>Case</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTransactions.map((transaction) => (
                    <tr className={selectedTransaction.id === transaction.id ? "selected-row" : ""} key={transaction.id} onClick={() => previewCase(transaction)}>
                      <td>{transaction.id}</td>
                      <td>{transaction.customerEmail}</td>
                      <td>{transaction.giftCard}</td>
                      <td><span className={`risk-badge ${transaction.riskLevel.toLowerCase()}`}>{transaction.riskScore}/100 · {transaction.riskLevel}</span></td>
                      <td>{transaction.fraudProbability}</td>
                      <td><span className={`status-badge ${transaction.status}`}>{transaction.status.replace("_", " ")}</span></td>
                      <td><span className={`case-badge ${getCaseStatus(transaction)}`}>{getCaseStatus(transaction)}</span></td>
                      <td><button onClick={(event) => { event.stopPropagation(); openReview(transaction); }} type="button">Review</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <aside className="queue-detail-panel">
                <div className="card-heading">
                  <h3>Expanded Detail Panel</h3>
                  <small>{selectedTransaction.id}</small>
                </div>
                <p>{getFlaggedReason(selectedTransaction)}</p>
                <div className="case-strip">
                  <span className={`risk-badge ${selectedTransaction.riskLevel.toLowerCase()}`}>{selectedTransaction.riskLevel}</span>
                  <span className={`case-badge ${getCaseStatus(selectedTransaction)}`}>{getCaseStatus(selectedTransaction)}</span>
                  <span className="confidence-badge">{getConfidenceLabel(selectedTransaction)}</span>
                </div>
                <div className="evidence-list compact-evidence">
                  {getEvidenceIndicators(selectedTransaction).slice(0, 3).map((item) => (
                    <span className={item.tone} key={item.label}>
                      <b>{item.label}</b>
                      <em>{item.value}</em>
                    </span>
                  ))}
                </div>
                <button onClick={() => openReview(selectedTransaction)} type="button">Open Full Review</button>
              </aside>
            </div>
          </div>
        </div>
      </Panel>
    </AdminFrame>
  );
}

export function AdminCasesScreen() {
  const router = useRouter();
  const [transactions, setTransactions] = useState<AdminTransaction[]>(fallbackAdminTransactions);
  const [selectedCase, setSelectedCase] = useState<AdminTransaction>(fallbackAdminTransactions[0]);
  const [query, setQuery] = useState("");
  const [caseFilter, setCaseFilter] = useState("All");
  const [sortMode, setSortMode] = useState("Risk score");
  const caseCounts = {
    pending: transactions.filter((item) => getCaseStatus(item) === "pending").length,
    reviewing: transactions.filter((item) => getCaseStatus(item) === "reviewing").length,
    resolved: transactions.filter((item) => getCaseStatus(item) === "resolved").length,
    blocked: transactions.filter((item) => getCaseStatus(item) === "blocked").length,
  };
  const filteredCases = transactions
    .filter((item) => caseFilter === "All" || getCaseStatus(item) === caseFilter)
    .filter((item) => `${item.id} ${item.customerEmail} ${item.giftCard} ${item.riskLevel} ${getCaseStatus(item)}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => {
      if (sortMode === "Newest") return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      if (sortMode === "Case status") return getCaseStatus(a).localeCompare(getCaseStatus(b));
      return b.riskScore - a.riskScore;
    });

  useEffect(() => {
    const nextTransactions = getAdminTransactions();
    setTransactions(nextTransactions);
    setSelectedCase(nextTransactions[0] ?? fallbackAdminTransactions[0]);
  }, []);

  function openReview(transaction: AdminTransaction) {
    localStorage.setItem("nexagift:adminSelectedTransaction", JSON.stringify(transaction));
    appendAuditLog({
      action: "Review Opened",
      transactionId: transaction.id,
      customerStatus: getCaseStatus(transaction),
      modelResult: `${transaction.riskLevel} risk, ${transaction.fraudProbability}`,
      reason: "Administrator opened the case from the case management board.",
    });
    router.push(withBasePath("/admin/review"));
  }

  return (
    <AdminFrame>
      <Panel number="A3" title="Cases" subtitle="Fraud review case board with analyst workflow states" className="admin-dashboard-panel">
        <AdminNav active="cases" />
        <div className="admin-workspace">
          <div className="case-state-grid full-span">
            <button className={`case-state-card pending ${caseFilter === "pending" ? "active" : ""}`} onClick={() => setCaseFilter("pending")} type="button">
              <span>Pending</span>
              <b>{caseCounts.pending}</b>
              <small>Needs analyst review</small>
            </button>
            <button className={`case-state-card reviewing ${caseFilter === "reviewing" ? "active" : ""}`} onClick={() => setCaseFilter("reviewing")} type="button">
              <span>Reviewing</span>
              <b>{caseCounts.reviewing}</b>
              <small>OTP or extra check</small>
            </button>
            <button className={`case-state-card resolved ${caseFilter === "resolved" ? "active" : ""}`} onClick={() => setCaseFilter("resolved")} type="button">
              <span>Resolved</span>
              <b>{caseCounts.resolved}</b>
              <small>Approved delivery</small>
            </button>
            <button className={`case-state-card blocked ${caseFilter === "blocked" ? "active" : ""}`} onClick={() => setCaseFilter("blocked")} type="button">
              <span>Blocked</span>
              <b>{caseCounts.blocked}</b>
              <small>No code release</small>
            </button>
          </div>

          <div className="dashboard-card full-span">
            <div className="card-heading">
              <div>
                <h3>Case Management Controls</h3>
                <small>Search, filter, sort, and open cases for SHAP review.</small>
              </div>
              <button className="ghost-action compact-reset" onClick={() => setCaseFilter("All")} type="button">Show All</button>
            </div>
            <div className="admin-controls case-controls">
              <label>
                Search cases
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="TXN, email, gift card, risk" />
              </label>
              <label>
                Case status
                <select value={caseFilter} onChange={(event) => setCaseFilter(event.target.value)}>
                  <option>All</option>
                  <option value="pending">Pending</option>
                  <option value="reviewing">Reviewing</option>
                  <option value="resolved">Resolved</option>
                  <option value="blocked">Blocked</option>
                </select>
              </label>
              <label>
                Sort by
                <select value={sortMode} onChange={(event) => setSortMode(event.target.value)}>
                  <option>Risk score</option>
                  <option>Newest</option>
                  <option>Case status</option>
                </select>
              </label>
            </div>
          </div>

          <div className="admin-cases-grid full-span">
            <div className="dashboard-card case-list-card">
              <div className="card-heading">
                <div>
                  <h3>Case Queue</h3>
                  <small>{filteredCases.length} visible case(s)</small>
                </div>
                <Link href={withBasePath("/admin/transactions")}>Risk table</Link>
              </div>
              {!filteredCases.length ? (
                <div className="empty-state-card audit-empty">
                  <b>No cases matched</b>
                  <span>Try Show All, clear search text, or load a demo scenario.</span>
                </div>
              ) : null}
              <table className="admin-table case-table">
                <thead>
                  <tr>
                    <th>Case</th>
                    <th>Transaction</th>
                    <th>Risk</th>
                    <th>Customer</th>
                    <th>Status</th>
                    <th>Recommendation</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCases.map((transaction) => (
                    <tr className={selectedCase.id === transaction.id ? "selected-row" : ""} key={transaction.id} onClick={() => setSelectedCase(transaction)}>
                      <td><span className={`case-badge ${getCaseStatus(transaction)}`}>{getCaseStatus(transaction)}</span></td>
                      <td>{transaction.id}</td>
                      <td><span className={`risk-badge ${transaction.riskLevel.toLowerCase()}`}>{transaction.riskScore}/100</span></td>
                      <td>{transaction.customerEmail}</td>
                      <td><span className={`status-badge ${transaction.status}`}>{transaction.status.replace("_", " ")}</span></td>
                      <td>{transaction.modelRecommendation}</td>
                      <td><button onClick={(event) => { event.stopPropagation(); openReview(transaction); }} type="button">Review</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <aside className="dashboard-card case-detail-panel">
              <div className="card-heading">
                <div>
                  <h3>Why Flagged / Evidence</h3>
                  <small>{selectedCase.id}</small>
                </div>
                <span className="confidence-badge">{getConfidenceLabel(selectedCase)}</span>
              </div>
              <p>{getFlaggedReason(selectedCase)}</p>
              <div className="status-grid admin-detail-grid">
                <Line label="Gift Card" value={selectedCase.giftCard} />
                <Line label="Fraud Prob." value={selectedCase.fraudProbability} />
                <Line label="Risk Level" value={selectedCase.riskLevel} />
                <Line label="Customer Status" value={selectedCase.status.replace("_", " ")} />
              </div>
              <div className="evidence-list compact-evidence">
                {getEvidenceIndicators(selectedCase).map((item) => (
                  <span className={item.tone} key={item.label}>
                    <b>{item.label}</b>
                    <em>{item.value}</em>
                  </span>
                ))}
              </div>
              <div className="activity-list case-context-list">
                {getRelatedTransactionContext(selectedCase).slice(0, 3).map((item) => (
                  <span key={item.label}><b>{item.label}</b><em>{item.value}</em></span>
                ))}
              </div>
              <button onClick={() => openReview(selectedCase)} type="button">Open Full Review</button>
            </aside>
          </div>
        </div>
      </Panel>
    </AdminFrame>
  );
}

export function AdminReviewScreen() {
  const router = useRouter();
  const [transaction, setTransaction] = useState<AdminTransaction>(fallbackAdminTransactions[0]);
  const [hasSelectedTransaction, setHasSelectedTransaction] = useState(true);
  const [decisionNote, setDecisionNote] = useState("");
  const [decisionError, setDecisionError] = useState("");
  const [confirmation, setConfirmation] = useState("");

  useEffect(() => {
    const stored = localStorage.getItem("nexagift:adminSelectedTransaction");
    const lastTransaction = localStorage.getItem("nexagift:lastTransaction");
    if (stored) {
      const selectedTransaction = safeJsonParse<AdminTransaction>(stored);
      if (selectedTransaction) {
        setTransaction(selectedTransaction);
        setHasSelectedTransaction(true);
      }
    } else if (lastTransaction) {
      const transaction = safeJsonParse<StoredTransaction>(lastTransaction);
      if (transaction) {
        setTransaction(toAdminTransaction(transaction));
        setHasSelectedTransaction(true);
      }
    } else {
      setHasSelectedTransaction(false);
    }
  }, []);

  function decide(action: "Allow" | "Require OTP" | "Block") {
    if (!hasSelectedTransaction) {
      setDecisionError("No risky transaction selected. Open a transaction from the review queue first.");
      return;
    }
    if (!decisionNote.trim()) {
      setDecisionError("Please enter a decision note before submitting the admin action.");
      return;
    }
    updateCustomerFromAdmin(action, transaction, decisionNote.trim());
    setConfirmation(`${action} submitted. Customer status and audit log were updated.`);
    setDecisionNote("");
  }

  return (
    <AdminFrame>
      <Panel number="A4" title="Transaction Detail / Review" subtitle="Fraud probability, SHAP evidence, and admin decision" className="admin-review-panel">
        <AdminNav active="review" />
        <div className="admin-workspace review-workspace">
          {!hasSelectedTransaction ? (
            <div className="empty-state-card full-span">
              <b>No risky transaction selected</b>
              <span>Open a transaction from Risky Transactions before submitting Allow, OTP, or Block decisions.</span>
              <Link className="back-button" href={withBasePath("/admin/transactions")}>Open Review Queue</Link>
            </div>
          ) : null}
          <div className="dashboard-card">
            <div className="card-heading">
              <h3>Transaction Evidence</h3>
              <small>{transaction.scenario}</small>
            </div>
            <div className="status-grid admin-detail-grid">
              <Line label="Transaction ID" value={transaction.id} />
              <Line label="Customer Email" value={transaction.customerEmail} />
              <Line label="Selected Gift Card" value={transaction.giftCard} />
              <Line label="Amount" value={transaction.amount} />
              <Line label="Card Type" value={transaction.brand} />
              <Line label="Payment Details" value={transaction.paymentCard} />
              <Line label="Billing Country" value={transaction.billingCountry} />
              <Line label="Fraud Probability" value={transaction.fraudProbability} />
              <Line label="AI Recommendation" value={transaction.modelRecommendation} />
            </div>
          </div>

          <div className="dashboard-card why-flagged-card">
            <div className="card-heading">
              <h3>Why This Was Flagged</h3>
              <small>Plain-language analyst summary</small>
            </div>
            <p>{getFlaggedReason(transaction)}</p>
            <div className="case-strip">
              <span className={`case-badge ${getCaseStatus(transaction)}`}>{getCaseStatus(transaction)}</span>
              <span className={`risk-badge ${transaction.riskLevel.toLowerCase()}`}>{transaction.riskLevel} risk</span>
              <span className="confidence-badge">{getConfidenceLabel(transaction)}</span>
            </div>
          </div>

          <div className="dashboard-card evidence-summary-card">
            <div className="card-heading">
              <h3>Fraud Indicator Evidence</h3>
              <small>Signals used by model + risk engine</small>
            </div>
            <div className="evidence-list">
              {getEvidenceIndicators(transaction).map((item) => (
                <span className={item.tone} key={item.label}>
                  <b>{item.label}</b>
                  <em>{item.value}</em>
                </span>
              ))}
            </div>
          </div>

          <div className="dashboard-card related-context-card">
            <div className="card-heading">
              <h3>Previous Related Context</h3>
              <small>Customer/device/payment history</small>
            </div>
            <div className="insight-list compact">
              {getRelatedTransactionContext(transaction).map((item) => (
                <Line key={item.label} label={item.label} value={item.value} />
              ))}
            </div>
          </div>

          <div className="dashboard-card risk-review-card">
            <div className={`risk-ring ${transaction.riskLevel.toLowerCase()}`}>
              <span>Risk Level</span>
              <strong>{transaction.riskLevel}</strong>
            </div>
            <div className="risk-copy">
              <small>Risk Score</small>
              <strong>{transaction.riskScore} <em>/ 100</em></strong>
              <b className={transaction.riskLevel.toLowerCase()}>{transaction.modelRecommendation}</b>
              <small>Fraud Probability</small>
              <strong>{transaction.fraudProbability}</strong>
            </div>
          </div>

          <div className="dashboard-card shap-panel">
            <div className="card-heading">
              <h3>SHAP Explanation Panel</h3>
              <small>Top contributing features</small>
            </div>
            {transaction.shap.map((item) => (
              <div className="shap-row" key={item.feature}>
                <span>{item.feature}</span>
                <i><b className={item.direction === "up" ? "up" : "down"} style={{ width: `${item.value}%` }} /></i>
                <em>{item.impact}</em>
              </div>
            ))}
          </div>

          <div className="actions-card review-action-card">
            <h3>Admin Review Action</h3>
            <label className="review-note-field">
              Decision Note
              <textarea
                onChange={(event) => {
                  setDecisionNote(event.target.value);
                  setDecisionError("");
                }}
                placeholder="Write the review reason before Allow, OTP, or Block."
                value={decisionNote}
              />
            </label>
            {decisionError ? <small className="login-error form-error">{decisionError}</small> : null}
            {confirmation ? (
              <small className="decision-confirmation">
                {confirmation} <Link href={withBasePath("/admin/audit")}>View Audit Log</Link>
              </small>
            ) : null}
            <button onClick={() => decide("Allow")} type="button">Allow</button>
            <button className="medium" onClick={() => decide("Require OTP")} type="button">Require OTP</button>
            <button className="danger" onClick={() => decide("Block")} type="button">Block</button>
            <button className="ghost-action" onClick={() => router.push(withBasePath("/admin/audit"))} type="button">Open Audit</button>
          </div>
        </div>
      </Panel>
    </AdminFrame>
  );
}

export function AdminAuditLogScreen() {
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [query, setQuery] = useState("");
  const [actionFilter, setActionFilter] = useState("All");
  const allowCount = records.filter((record) => record.action === "Allow").length;
  const otpCount = records.filter((record) => record.action === "Require OTP").length;
  const blockCount = records.filter((record) => record.action === "Block").length;
  const filteredRecords = records
    .filter((record) => actionFilter === "All" || record.action === actionFilter)
    .filter((record) => `${record.transactionId} ${record.customerStatus} ${record.modelResult} ${record.reason}`.toLowerCase().includes(query.toLowerCase()));

  useEffect(() => {
    setRecords(getAuditLog());
  }, []);

  return (
    <AdminFrame>
      <Panel number="A5" title="Audit Log" subtitle="Traceable administrator decisions and customer status updates" className="admin-dashboard-panel">
        <AdminNav active="audit" />
        <div className="admin-workspace">
          <div className="dashboard-card full-span">
            <div className="card-heading">
              <h3>Security Timeline</h3>
              <small>Every admin decision is stored locally for the thesis demo.</small>
            </div>
            <div className="audit-summary-strip">
              <span><b>{records.length}</b> total events</span>
              <span><b>{allowCount}</b> approved</span>
              <span><b>{otpCount}</b> OTP required</span>
              <span><b>{blockCount}</b> blocked</span>
            </div>
            <div className="admin-controls audit-controls">
              <label>
                Search audit
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="TXN, status, model result, note" />
              </label>
              <label>
                Action
                <select value={actionFilter} onChange={(event) => setActionFilter(event.target.value)}>
                  <option>All</option>
                  <option>Allow</option>
                  <option>Require OTP</option>
                  <option>Block</option>
                  <option>Review Opened</option>
                  <option>Login</option>
                </select>
              </label>
            </div>
            {!records.length ? (
              <div className="empty-state-card audit-empty">
                <b>No admin action yet</b>
                <span>Allow, Require OTP, and Block decisions will appear here with the admin note after review.</span>
              </div>
            ) : null}
            {records.length && !filteredRecords.length ? (
              <div className="empty-state-card audit-empty">
                <b>No audit events matched</b>
                <span>Try a different transaction ID, action type, model result, or decision note.</span>
              </div>
            ) : null}
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Admin Action</th>
                  <th>Transaction ID</th>
                  <th>Customer Status Update</th>
                  <th>Model Result</th>
                  <th>Reason / Note</th>
                </tr>
              </thead>
              <tbody>
                {(records.length ? filteredRecords : [{
                  id: "AUD-000001",
                  timestamp: "No record yet",
                  action: "Review Opened" as const,
                  transactionId: "TXN-904271",
                  customerStatus: "under review",
                  modelResult: "High risk, 76.2% fraud probability",
                  reason: "No admin action has been recorded yet.",
                }]).map((record) => (
                  <tr key={record.id}>
                    <td>{record.timestamp}</td>
                    <td>{record.action}</td>
                    <td>{record.transactionId}</td>
                    <td>{record.customerStatus}</td>
                    <td>{record.modelResult}</td>
                    <td>{record.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Panel>
    </AdminFrame>
  );
}

type AdminNavItem = "overview" | "cases" | "transactions" | "review" | "audit";

function AdminNav({ active }: { active: AdminNavItem }) {
  return (
    <nav className="admin-sidebar" aria-label="Admin navigation">
      <Link className={active === "overview" ? "active" : ""} href={withBasePath("/admin/dashboard")}>Overview</Link>
      <Link className={active === "cases" ? "active" : ""} href={withBasePath("/admin/cases")}>Cases</Link>
      <Link className={active === "transactions" ? "active" : ""} href={withBasePath("/admin/transactions")}>Risky Transactions</Link>
      <Link className={active === "review" ? "active" : ""} href={withBasePath("/admin/review")}>SHAP Review</Link>
      <Link className={active === "audit" ? "active" : ""} href={withBasePath("/admin/audit")}>Audit Log</Link>
      <Link href={withBasePath("/")}>Customer Login</Link>
      <ResetDemoButton compact />
    </nav>
  );
}

function Metric({ label, value, trend, warn = false }: { label: string; value: string; trend: string; warn?: boolean }) {
  return (
    <div className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <small className={warn ? "warn" : ""}>{trend}</small>
    </div>
  );
}

function TransactionTable({ transactions }: { transactions: AdminTransaction[] }) {
  function selectForReview(transaction: AdminTransaction) {
    if (typeof window === "undefined") return;
    localStorage.setItem("nexagift:adminSelectedTransaction", JSON.stringify(transaction));
  }

  return (
    <table className="admin-table">
      <thead>
        <tr>
          <th>TXN ID</th>
          <th>Customer</th>
          <th>Gift Card</th>
          <th>Risk Score</th>
          <th>Fraud Prob.</th>
          <th>Status</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        {transactions.map((transaction) => (
          <tr key={transaction.id}>
            <td>{transaction.id}</td>
            <td>{transaction.customerEmail}</td>
            <td>{transaction.giftCard}</td>
            <td><span className={`risk-badge ${transaction.riskLevel.toLowerCase()}`}>{transaction.riskScore}/100 · {transaction.riskLevel}</span></td>
            <td>{transaction.fraudProbability}</td>
            <td><span className={`status-badge ${transaction.status}`}>{transaction.status.replace("_", " ")}</span></td>
            <td><Link className="table-link" href={withBasePath("/admin/review")} onClick={() => selectForReview(transaction)}>Review</Link></td>
          </tr>
        ))}
        {!transactions.length ? (
          <tr>
            <td colSpan={7}>No flagged transactions matched the current filters.</td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}

function AdminAuditPreview() {
  const [records, setRecords] = useState<AuditRecord[]>([]);

  useEffect(() => {
    setRecords(getAuditLog().slice(0, 4));
  }, []);

  const preview = records.length ? records : [
    {
      id: "AUD-PREVIEW",
      timestamp: "No record yet",
      action: "Review Opened" as const,
      transactionId: "TXN-904271",
      customerStatus: "under review",
      modelResult: "High risk",
      reason: "Waiting for admin decision.",
    },
  ];

  return (
    <div className="audit-preview-list">
      {preview.map((record) => (
        <div className="audit-row" key={record.id}>
          <span>●</span>
          <p>{record.action}</p>
          <b>{record.transactionId}</b>
          <small>{record.customerStatus}</small>
        </div>
      ))}
    </div>
  );
}

function Panel({
  number,
  title,
  subtitle,
  className,
  children,
}: {
  number: string;
  title: string;
  subtitle: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <article className={`board-panel ${className ?? ""}`}>
      <div className="panel-title">
        <span>{number}</span>
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
      </div>
      {children}
    </article>
  );
}

function InfoCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="info-card">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="line-row">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}
