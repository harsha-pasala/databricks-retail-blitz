import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useUser } from "@/lib/UserContext";

export const Route = createFileRoute("/profile")({
  component: () => <ProfilePage />,
});

const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "INR", "BRL", "MXN"];

const COUNTRIES = [
  { name: "United States", code: "US" },
  { name: "United Kingdom", code: "GB" },
  { name: "Canada", code: "CA" },
  { name: "Germany", code: "DE" },
  { name: "France", code: "FR" },
  { name: "Japan", code: "JP" },
  { name: "Australia", code: "AU" },
  { name: "India", code: "IN" },
  { name: "Brazil", code: "BR" },
  { name: "Mexico", code: "MX" },
  { name: "Switzerland", code: "CH" },
  { name: "Netherlands", code: "NL" },
  { name: "Singapore", code: "SG" },
  { name: "South Korea", code: "KR" },
  { name: "UAE", code: "AE" },
  { name: "Italy", code: "IT" },
  { name: "Spain", code: "ES" },
  { name: "China", code: "CN" },
  { name: "South Africa", code: "ZA" },
  { name: "Sweden", code: "SE" },
];

function DatabricksLogo() {
  return (
    <svg width="28" height="28" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M18 0L3.6 8.28V12.78L18 21.24L32.4 12.78V8.28L18 0Z" fill="#FF3621" />
      <path d="M18 24.6L3.6 16.14V20.64L18 29.1L32.4 20.64V16.14L18 24.6Z" fill="#FF3621" />
      <path d="M18 32.34L3.6 23.88V28.38L18 36.84L32.4 28.38V23.88L18 32.34Z" fill="#FF3621" />
    </svg>
  );
}

interface UserItem {
  user_id: string;
  full_name: string;
  email: string;
  credit_card_number?: string;
}

interface SaveToast {
  visible: boolean;
  status: string;
  message: string;
}

type SyncState = "idle" | "waiting" | "synced" | "timeout";

function ProfilePage() {
  const { selectedUser, setSelectedUser } = useUser();

  // User list for dropdown
  const [users, setUsers] = useState<UserItem[]>([]);

  // Profile form fields
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [countryCode, setCountryCode] = useState("US");
  const [currency, setCurrency] = useState("USD");
  const [allowInternational, setAllowInternational] = useState(false);
  const [dailyLimit, setDailyLimit] = useState(5000);
  const [cardNumber, setCardNumber] = useState("");
  const [cardNetwork, setCardNetwork] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<SaveToast>({
    visible: false,
    status: "",
    message: "",
  });

  const [syncState, setSyncState] = useState<SyncState>("idle");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sentPayloadRef = useRef<Record<string, unknown> | null>(null);

  // Fetch user list on mount
  useEffect(() => {
    fetch("/api/users")
      .then((r) => r.json())
      .then((data: UserItem[]) => setUsers(data))
      .catch(() => {});
  }, []);

  // Load profile when selected user changes
  useEffect(() => {
    if (!selectedUser) return;
    fetch(`/api/profile?user_id=${encodeURIComponent(selectedUser.userId)}`)
      .then((r) => r.json())
      .then((data) => {
        setFullName(data.full_name || "");
        setEmail(data.email || "");
        setPhone(data.phone ?? "");
        setCountryCode(data.country_of_residence || "US");
        setCurrency(data.preferred_currency || "USD");
        setAllowInternational(data.allow_international_transactions ?? true);
        setDailyLimit(data.daily_limit ?? 5000);
        setCardNumber(data.credit_card_number || "");
        setCardNetwork(data.card_network || "");
      })
      .catch(() => {});
  }, [selectedUser]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    if (!selectedUser) return;
    stopPolling();
    setSyncState("waiting");
    let attempts = 0;
    const maxAttempts = 10; // 10 * 2s = 20s for direct DB write

    pollRef.current = setInterval(async () => {
      attempts++;
      try {
        const res = await fetch(
          `/api/profile?user_id=${encodeURIComponent(selectedUser.userId)}`
        );
        const data = await res.json();

        const sent = sentPayloadRef.current;
        if (
          sent &&
          data.allow_international_transactions === sent.allow_international_transactions &&
          data.daily_limit === sent.daily_limit &&
          data.country_of_residence === sent.country_of_residence
        ) {
          setSyncState("synced");
          stopPolling();
          setTimeout(() => setSyncState("idle"), 8000);
          return;
        }
      } catch { /* ignore */ }

      if (attempts >= maxAttempts) {
        setSyncState("timeout");
        stopPolling();
        setTimeout(() => setSyncState("idle"), 6000);
      }
    }, 2000);
  }, [selectedUser, stopPolling]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const handleUserChange = (userId: string) => {
    const user = users.find((u) => u.user_id === userId);
    if (user) {
      setSelectedUser({ userId: user.user_id, fullName: user.full_name });
    }
  };

  const handleCountryChange = (value: string) => {
    setCountryCode(value);
  };

  const handleSubmit = async () => {
    if (!selectedUser) return;
    setSubmitting(true);
    try {
      const payload = {
        user_id: selectedUser.userId,
        full_name: fullName,
        email,
        phone,
        country_of_residence: countryCode,
        preferred_currency: currency,
        allow_international_transactions: allowInternational,
        daily_limit: dailyLimit,
      };

      sentPayloadRef.current = payload;

      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      setToast({
        visible: true,
        status: data.status === "saved" ? "success" : "error",
        message: data.message,
      });
      setTimeout(() => setToast((t) => ({ ...t, visible: false })), 5000);

      if (data.status === "saved") {
        startPolling();
      }
    } finally {
      setSubmitting(false);
    }
  };

  const limitPercent = ((dailyLimit - 100) / (50000 - 100)) * 100;

  return (
    <div className="relative min-h-screen w-screen flex flex-col bg-background">
      {/* Navbar */}
      <header className="z-50 bg-background/90 backdrop-blur-sm border-b border-border">
        <div className="h-14 flex items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <Link to="/" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
              <DatabricksLogo />
              <div className="flex flex-col">
                <span className="text-sm font-bold tracking-tight text-foreground leading-tight">
                  Retail Transaction
                </span>
                <span className="text-[10px] text-muted-foreground leading-tight">
                  Replication System
                </span>
              </div>
            </Link>
          </div>
          <div className="flex items-center gap-4">
            <Link
              to="/"
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <polyline points="9 22 9 12 15 12 15 22" />
              </svg>
              Transactions
            </Link>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <div className="w-2 h-2 rounded-full bg-[#00A972] animate-pulse" />
              Online
            </div>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-8 space-y-8">
          {/* Page Header */}
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 rounded-full bg-gradient-to-br from-[#FF3621] to-[#FF6F61] flex items-center justify-center text-white text-2xl font-bold">
              {fullName.split(" ").map((n) => n[0]).join("").slice(0, 2)}
            </div>
            <div className="flex-1">
              <h1 className="text-2xl font-bold text-foreground">User Profile</h1>
              <p className="text-sm text-muted-foreground">
                Manage account settings and preferences
              </p>
            </div>
          </div>

          {/* User Selector */}
          <section className="rounded-xl border border-border bg-card p-6 space-y-4">
            <div className="flex items-center gap-2 mb-1">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[#FF3621]">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
              <h2 className="text-base font-semibold text-foreground">Select User</h2>
            </div>
            <select
              value={selectedUser?.userId || ""}
              onChange={(e) => handleUserChange(e.target.value)}
              className="w-full h-10 rounded-lg border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-[#FF3621]/50 focus:border-[#FF3621]/50 transition-all"
            >
              {users.map((u) => (
                <option key={u.user_id} value={u.user_id}>
                  {u.full_name} ({u.user_id})
                </option>
              ))}
            </select>
          </section>

          {/* Sync Status Banner */}
          <AnimatePresence>
            {syncState !== "idle" && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <div
                  className={`rounded-xl border p-4 flex items-center gap-3 ${
                    syncState === "waiting"
                      ? "border-yellow-500/30 bg-yellow-500/5"
                      : syncState === "synced"
                        ? "border-[#00A972]/30 bg-[#00A972]/5"
                        : "border-red-500/30 bg-red-500/5"
                  }`}
                >
                  {syncState === "waiting" && (
                    <>
                      <div className="w-5 h-5 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin" />
                      <div>
                        <p className="text-sm font-medium text-yellow-400">
                          Saving to Postgres...
                        </p>
                        <p className="text-xs text-yellow-400/70 mt-0.5">
                          Writing profile to customer_features table
                        </p>
                      </div>
                    </>
                  )}
                  {syncState === "synced" && (
                    <>
                      <div className="w-5 h-5 rounded-full bg-[#00A972] flex items-center justify-center">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className="text-white">
                          <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                      <div>
                        <p className="text-sm font-medium text-[#00A972]">
                          Profile saved to Postgres!
                        </p>
                        <p className="text-xs text-[#00A972]/70 mt-0.5">
                          Changes are live — transactions will use updated rules
                        </p>
                      </div>
                    </>
                  )}
                  {syncState === "timeout" && (
                    <>
                      <div className="w-5 h-5 rounded-full bg-red-500 flex items-center justify-center">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className="text-white">
                          <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                        </svg>
                      </div>
                      <div>
                        <p className="text-sm font-medium text-red-400">
                          Save verification timed out
                        </p>
                        <p className="text-xs text-red-400/70 mt-0.5">
                          Changes may have been saved but could not be verified
                        </p>
                      </div>
                    </>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Personal Information */}
          <section className="rounded-xl border border-border bg-card p-6 space-y-5">
            <div className="flex items-center gap-2 mb-1">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[#FF3621]">
                <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              <h2 className="text-base font-semibold text-foreground">Personal Information</h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FieldInput label="Full Name" value={fullName} onChange={setFullName} />
              <FieldInput label="Email" value={email} onChange={setEmail} type="email" />
              <FieldInput label="Phone" value={phone} onChange={setPhone} type="tel" />
              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Account ID
                </label>
                <div className="h-10 rounded-lg border border-border bg-muted/30 px-3 flex items-center text-sm text-muted-foreground font-mono">
                  {selectedUser?.userId || "—"}
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Credit Card
                </label>
                <div className="h-10 rounded-lg border border-border bg-muted/30 px-3 flex items-center text-sm text-muted-foreground font-mono tracking-wider">
                  {cardNumber
                    ? cardNumber.replace(/(\d{4})(?=\d)/g, "$1 ")
                    : "—"}
                </div>
              </div>
              {cardNetwork && (
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Card Network
                  </label>
                  <div className="h-10 rounded-lg border border-border bg-muted/30 px-3 flex items-center text-sm text-muted-foreground">
                    {cardNetwork}
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Settings */}
          <section className="rounded-xl border border-border bg-card p-6 space-y-5">
            <div className="flex items-center gap-2 mb-1">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[#FF3621]">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <h2 className="text-base font-semibold text-foreground">Settings</h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Country of Residence
                </label>
                <select
                  value={countryCode}
                  onChange={(e) => handleCountryChange(e.target.value)}
                  className="w-full h-10 rounded-lg border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-[#FF3621]/50 focus:border-[#FF3621]/50 transition-all"
                >
                  {COUNTRIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Preferred Currency
                </label>
                <select
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  className="w-full h-10 rounded-lg border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-[#FF3621]/50 focus:border-[#FF3621]/50 transition-all"
                >
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Daily Limit Slider */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Daily Transaction Limit
                </label>
                <span className="text-lg font-bold text-[#FF3621]">
                  ${dailyLimit.toLocaleString()}
                </span>
              </div>
              <input
                type="range"
                min={100}
                max={50000}
                step={100}
                value={dailyLimit}
                onChange={(e) => setDailyLimit(Number(e.target.value))}
                className="w-full h-2 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#FF3621] [&::-webkit-slider-thumb]:shadow-lg [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-[#FF3621] [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white [&::-moz-range-thumb]:cursor-pointer"
                style={{
                  background: `linear-gradient(to right, #FF3621 0%, #FF3621 ${limitPercent}%, var(--color-muted) ${limitPercent}%, var(--color-muted) 100%)`,
                }}
              />
              <div className="flex justify-between">
                <span className="text-[10px] text-muted-foreground">$100</span>
                <span className="text-[10px] text-muted-foreground">$50K</span>
              </div>
            </div>

            {/* Toggle Settings */}
            <div className="space-y-3 pt-2">
              <Toggle
                label="Allow International Transactions"
                description="Enable transactions from countries other than your residence"
                checked={allowInternational}
                onChange={setAllowInternational}
              />
            </div>
          </section>

          {/* Submit */}
          <div className="pb-8">
            <button
              onClick={handleSubmit}
              disabled={submitting}
              className={`w-full h-12 rounded-lg font-semibold text-sm tracking-wide transition-all duration-200 ${
                submitting
                  ? "bg-muted text-muted-foreground cursor-not-allowed"
                  : "bg-[#FF3621] hover:bg-[#E52E1A] text-white shadow-lg shadow-[#FF3621]/20 hover:shadow-[#FF3621]/40 active:scale-[0.98]"
              }`}
            >
              {submitting ? "Saving..." : "Save Profile"}
            </button>
          </div>
        </div>
      </main>

      {/* Save Toast */}
      <AnimatePresence>
        {toast.visible && (
          <motion.div
            className="fixed bottom-6 right-6 z-50 max-w-sm"
            initial={{ opacity: 0, y: 40, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            transition={{ duration: 0.3 }}
          >
            <div className={`rounded-xl border shadow-2xl overflow-hidden ${
              toast.status === "success"
                ? "border-[#00A972]/30 bg-card"
                : "border-red-500/30 bg-card"
            }`}>
              <div className={`h-1 ${toast.status === "success" ? "bg-[#00A972]" : "bg-red-500"}`} />
              <div className="p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center ${
                    toast.status === "success" ? "bg-[#00A972]" : "bg-red-500"
                  }`}>
                    {toast.status === "success" ? (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className="text-white">
                        <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className="text-white">
                        <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                      </svg>
                    )}
                  </div>
                  <span className="text-sm font-semibold text-foreground">
                    {toast.status === "success" ? "Profile Saved" : "Save Failed"}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">{toast.message}</p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function FieldInput({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-10 rounded-lg border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-[#FF3621]/50 focus:border-[#FF3621]/50 transition-all"
      />
    </div>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      className="flex items-center justify-between p-3 rounded-lg border border-border hover:bg-accent/50 transition-colors cursor-pointer"
      onClick={() => onChange(!checked)}
    >
      <div className="flex-1 pr-4">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <div
        className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${
          checked ? "bg-[#FF3621]" : "bg-muted"
        }`}
      >
        <div
          className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${
            checked ? "translate-x-[22px]" : "translate-x-0.5"
          }`}
        />
      </div>
    </div>
  );
}
