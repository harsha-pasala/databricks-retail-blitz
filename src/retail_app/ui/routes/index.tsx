import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useCallback } from "react";
import { WorldMap } from "@/components/WorldMap";
import { CardTapAnimation } from "@/components/CardTapAnimation";

export const Route = createFileRoute("/")({
  component: () => <Index />,
});

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

function DatabricksLogo() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 36 36"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M18 0L3.6 8.28V12.78L18 21.24L32.4 12.78V8.28L18 0Z"
        fill="#FF3621"
      />
      <path
        d="M18 24.6L3.6 16.14V20.64L18 29.1L32.4 20.64V16.14L18 24.6Z"
        fill="#FF3621"
      />
      <path
        d="M18 32.34L3.6 23.88V28.38L18 36.84L32.4 28.38V23.88L18 32.34Z"
        fill="#FF3621"
      />
    </svg>
  );
}

function generateCardNumber(): string {
  const segments = Array.from({ length: 4 }, () =>
    Math.floor(1000 + Math.random() * 9000).toString()
  );
  return segments.join(" ");
}

interface LatencyBreakdown {
  modelCallMs: number;
  modelLookupMs?: number;
  modelInferenceMs?: number;
  modelTotalMs?: number;
}

interface TxnResult {
  declined: boolean;
  declineReason?: string;
  fraudProbability?: number;
  fraudFlag?: number;
  latency?: LatencyBreakdown;
}

function Index() {
  const [selectedCountry, setSelectedCountry] = useState<string | null>(null);
  const [selectedCountryCode, setSelectedCountryCode] = useState<string | null>(
    null
  );
  const [amount, setAmount] = useState(500);
  const [cardNumber, setCardNumber] = useState(generateCardNumber());
  const [showAnimation, setShowAnimation] = useState(false);
  const [txnResult, setTxnResult] = useState<TxnResult>({ declined: false });
  const [submitting, setSubmitting] = useState(false);

  const handleCountrySelect = useCallback((name: string, code: string) => {
    setSelectedCountry(name);
    setSelectedCountryCode(code);
  }, []);

  const handleCountryDeselect = useCallback(() => {
    setSelectedCountry(null);
    setSelectedCountryCode(null);
  }, []);

  const handleCardInput = (value: string) => {
    const digits = value.replace(/\D/g, "").slice(0, 16);
    const formatted = digits.replace(/(\d{4})(?=\d)/g, "$1 ");
    setCardNumber(formatted);
  };

  const handleSubmit = async () => {
    if (!selectedCountry || !cardNumber.replace(/\s/g, "") || submitting) return;
    setSubmitting(true);

    try {
      const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          country: selectedCountry,
          country_code: selectedCountryCode,
          amount,
          credit_card_number: cardNumber.replace(/\s/g, ""),
          currency: "USD",
        }),
      });
      const data = await res.json();

      const declined = data.status === "declined";
      const latency: LatencyBreakdown | undefined = data.latency
        ? {
            modelCallMs: data.latency.model_call_ms,
            modelLookupMs: data.latency.model_lookup_ms ?? undefined,
            modelInferenceMs: data.latency.model_inference_ms ?? undefined,
            modelTotalMs: data.latency.model_total_ms ?? undefined,
          }
        : undefined;

      setTxnResult({
        declined,
        declineReason: data.decline_reason ?? undefined,
        fraudProbability: data.fraud_probability ?? undefined,
        fraudFlag: data.fraud_flag ?? undefined,
        latency,
      });
      setShowAnimation(true);
    } catch {
      setTxnResult({
        declined: true,
        declineReason: "Network error — could not reach the server.",
      });
      setShowAnimation(true);
    } finally {
      setSubmitting(false);
    }
  };

  const sliderPercent = ((amount - 10) / (10000 - 10)) * 100;
  const isFormValid =
    selectedCountry && cardNumber.replace(/\s/g, "").length >= 12;

  return (
    <div className="relative h-screen w-screen overflow-hidden flex flex-col bg-background">
      {/* Navbar */}
      <header className="z-50 bg-background/90 backdrop-blur-sm border-b border-border">
        <div className="h-14 flex items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <DatabricksLogo />
            <div className="flex flex-col">
              <span className="text-sm font-bold tracking-tight text-foreground leading-tight">
                Retail Transaction
              </span>
              <span className="text-[10px] text-muted-foreground leading-tight">
                Replication System
              </span>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <Link
              to="/profile"
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              Profile
            </Link>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <div className="w-2 h-2 rounded-full bg-[#00A972] animate-pulse" />
              Online
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col lg:flex-row overflow-hidden">
        {/* Left: World Map */}
        <div className="flex-1 relative min-h-[300px] lg:min-h-0">
          <div className="absolute inset-0 bg-gradient-to-br from-background via-background to-[#FF3621]/5">
            <WorldMap
              selectedCountry={selectedCountry}
              selectedCountryCode={selectedCountryCode}
              onCountrySelect={handleCountrySelect}
              onCountryDeselect={handleCountryDeselect}
            />
          </div>

          {!selectedCountry && (
            <div className="absolute top-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full bg-card/90 backdrop-blur border border-border text-sm text-muted-foreground shadow-lg">
              Click a country on the map to select it
            </div>
          )}
        </div>

        {/* Right: Transaction Form */}
        <div className="w-full lg:w-[420px] border-t lg:border-t-0 lg:border-l border-border bg-card/50 backdrop-blur-sm flex flex-col">
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            {/* Header */}
            <div>
              <h2 className="text-xl font-bold text-foreground">
                New Transaction
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                Configure transaction parameters
              </p>
            </div>

            {/* Country Selection Display */}
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Country
              </label>
              <div
                className={`h-12 rounded-lg border-2 flex items-center px-4 transition-all duration-200 ${
                  selectedCountry
                    ? "border-[#FF3621]/50 bg-[#FF3621]/5"
                    : "border-dashed border-border bg-muted/30"
                }`}
              >
                {selectedCountry ? (
                  <div className="flex items-center justify-between w-full">
                    <span className="font-medium text-foreground">
                      {selectedCountry}
                    </span>
                    <button
                      onClick={() => {
                        setSelectedCountry(null);
                        setSelectedCountryCode(null);
                      }}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Change
                    </button>
                  </div>
                ) : (
                  <span className="text-sm text-muted-foreground">
                    Select from map &larr;
                  </span>
                )}
              </div>
            </div>

            {/* Amount Slider */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Amount
                </label>
                <span className="text-2xl font-bold text-[#FF3621]">
                  {formatCurrency(amount)}
                </span>
              </div>
              <div className="relative pt-1">
                <input
                  type="range"
                  min={10}
                  max={10000}
                  step={10}
                  value={amount}
                  onChange={(e) => setAmount(Number(e.target.value))}
                  className="w-full h-2 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#FF3621] [&::-webkit-slider-thumb]:shadow-lg [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-[#FF3621] [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white [&::-moz-range-thumb]:cursor-pointer"
                  style={{
                    background: `linear-gradient(to right, #FF3621 0%, #FF3621 ${sliderPercent}%, var(--color-muted) ${sliderPercent}%, var(--color-muted) 100%)`,
                  }}
                />
                <div className="flex justify-between mt-1">
                  <span className="text-[10px] text-muted-foreground">$10</span>
                  <span className="text-[10px] text-muted-foreground">$10K</span>
                </div>
              </div>
            </div>

            {/* Credit Card Number */}
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Credit Card Number
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={cardNumber}
                  onChange={(e) => handleCardInput(e.target.value)}
                  placeholder="0000 0000 0000 0000"
                  maxLength={19}
                  className="w-full h-12 rounded-lg border border-border bg-background px-4 pr-12 font-mono text-sm tracking-wider text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-[#FF3621]/50 focus:border-[#FF3621]/50 transition-all"
                />
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  <svg
                    width="24"
                    height="18"
                    viewBox="0 0 24 18"
                    fill="none"
                    className="text-muted-foreground/40"
                  >
                    <rect
                      x="0.5"
                      y="0.5"
                      width="23"
                      height="17"
                      rx="2.5"
                      stroke="currentColor"
                    />
                    <rect x="0" y="4" width="24" height="3" fill="currentColor" />
                  </svg>
                </div>
              </div>
            </div>

            {/* Payload Preview */}
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Transaction Payload
              </label>
              <div className="rounded-lg bg-[#1B3139] p-4 font-mono text-xs leading-relaxed overflow-x-auto">
                <span className="text-white/40">{"{"}</span>
                <br />
                <span className="text-[#FF6F61] ml-4">&quot;country&quot;</span>
                <span className="text-white/40">: </span>
                <span className="text-[#00A972]">
                  &quot;{selectedCountry || "..."}&quot;
                </span>
                <span className="text-white/40">,</span>
                <br />
                <span className="text-[#FF6F61] ml-4">
                  &quot;country_code&quot;
                </span>
                <span className="text-white/40">: </span>
                <span className="text-[#00A972]">
                  &quot;{selectedCountryCode || "..."}&quot;
                </span>
                <span className="text-white/40">,</span>
                <br />
                <span className="text-[#FF6F61] ml-4">&quot;amount&quot;</span>
                <span className="text-white/40">: </span>
                <span className="text-[#6CB6FF]">{amount}</span>
                <span className="text-white/40">,</span>
                <br />
                <span className="text-[#FF6F61] ml-4">
                  &quot;credit_card&quot;
                </span>
                <span className="text-white/40">: </span>
                <span className="text-[#00A972]">
                  &quot;{cardNumber || "..."}&quot;
                </span>
                <span className="text-white/40">,</span>
                <br />
                <span className="text-[#FF6F61] ml-4">&quot;currency&quot;</span>
                <span className="text-white/40">: </span>
                <span className="text-[#00A972]">&quot;USD&quot;</span>
                <br />
                <span className="text-white/40">{"}"}</span>
              </div>
            </div>
          </div>

          {/* Submit Button */}
          <div className="p-6 pt-0">
            <button
              onClick={handleSubmit}
              disabled={!isFormValid || submitting}
              className={`w-full h-12 rounded-lg font-semibold text-sm tracking-wide transition-all duration-200 ${
                isFormValid && !submitting
                  ? "bg-[#FF3621] hover:bg-[#E52E1A] text-white shadow-lg shadow-[#FF3621]/20 hover:shadow-[#FF3621]/40 active:scale-[0.98]"
                  : "bg-muted text-muted-foreground cursor-not-allowed"
              }`}
            >
              {submitting
                ? "Processing..."
                : isFormValid
                  ? "Submit Transaction"
                  : "Complete all fields"}
            </button>
          </div>
        </div>
      </main>

      {/* Card Tap Animation */}
      <CardTapAnimation
        visible={showAnimation}
        onComplete={() => setShowAnimation(false)}
        lastFour={cardNumber.replace(/\s/g, "").slice(-4) || "0000"}
        amount={formatCurrency(amount)}
        country={selectedCountry || ""}
        declined={txnResult.declined}
        declineReason={txnResult.declineReason}
        fraudProbability={txnResult.fraudProbability}
        latency={txnResult.latency}
      />
    </div>
  );
}
