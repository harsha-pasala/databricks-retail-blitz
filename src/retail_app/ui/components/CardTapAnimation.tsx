import { motion, AnimatePresence } from "motion/react";

interface LatencyBreakdown {
  modelCallMs: number;
  modelLookupMs?: number;
  modelInferenceMs?: number;
  modelTotalMs?: number;
  businessLogicMs?: number;
}

interface CardTapAnimationProps {
  visible: boolean;
  onComplete: () => void;
  lastFour: string;
  cardholderName?: string;
  amount: string;
  country: string;
  declined?: boolean;
  declineReason?: string;
  fraudProbability?: number;
  latency?: LatencyBreakdown;
}

function LatencyRow({
  label,
  ms,
  maxMs,
  color,
  indent = 0,
}: {
  label: string;
  ms: number;
  maxMs: number;
  color: string;
  indent?: number;
}) {
  const pct = Math.max((ms / maxMs) * 100, 2);
  return (
    <div className="flex items-center gap-2" style={{ paddingLeft: indent }}>
      <span className="text-[10px] text-white/50 w-[130px] shrink-0 text-right font-mono">
        {label}
      </span>
      <div className="flex-1 h-[14px] rounded-sm bg-white/5 relative overflow-hidden">
        <motion.div
          className="h-full rounded-sm"
          style={{ backgroundColor: color }}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.6, ease: "easeOut" }}
        />
      </div>
      <span className="text-[11px] text-white/70 w-[60px] shrink-0 font-mono tabular-nums text-right">
        {ms.toFixed(1)}ms
      </span>
    </div>
  );
}

export function CardTapAnimation({
  visible,
  onComplete,
  lastFour,
  cardholderName = "Cardholder",
  amount,
  declined = false,
  declineReason,
  fraudProbability,
  latency,
}: CardTapAnimationProps) {
  const accentColor = declined ? "#EF4444" : "#00A972";
  const pulseColor = declined ? "#EF4444" : "#FF3621";
  const screenText = declined ? "DECLINED" : "APPROVED";

  const maxMs = latency
    ? Math.max(
        latency.modelTotalMs ?? 0,
        latency.modelLookupMs ?? 0,
        latency.modelInferenceMs ?? 0,
        latency.businessLogicMs ?? 0,
        1
      )
    : 1;

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          onClick={onComplete}
        >
          <div className="relative flex flex-col items-center gap-8">
            {/* Card Reader */}
            <motion.div
              className="relative w-64 h-40 rounded-2xl bg-gradient-to-br from-[#1B3139] to-[#0D1B21] border border-white/10 shadow-2xl flex items-center justify-center"
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.4 }}
            >
              <div className="w-44 h-20 rounded-xl bg-gradient-to-b from-gray-900 to-gray-800 border border-white/5 flex flex-col items-center justify-center gap-1">
                <span
                  className="text-xs font-mono tracking-wider"
                  style={{ color: declined ? "#EF4444" : "#00E676" }}
                >
                  {screenText}
                </span>
                <span className="text-white/60 text-[10px] font-mono">
                  {amount}
                </span>
                {fraudProbability !== undefined && (
                  <span
                    className="text-[9px] font-mono"
                    style={{
                      color:
                        fraudProbability > 0.5
                          ? "#EF4444"
                          : fraudProbability > 0.1
                            ? "#F59E0B"
                            : "#00E676",
                    }}
                  >
                    Risk: {(fraudProbability * 100).toFixed(1)}%
                  </span>
                )}
              </div>

              <div className="absolute top-3 right-3">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  className="text-white/30"
                >
                  <path
                    d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                  <path
                    d="M8.5 8.5a5 5 0 017.07 0"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                  <path
                    d="M10 11a2.5 2.5 0 013.54 0"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                  <circle cx="11.77" cy="13" r="1" fill="currentColor" />
                </svg>
              </div>

              {/* Pulse rings */}
              <motion.div
                className="absolute inset-0 rounded-2xl border-2"
                style={{ borderColor: pulseColor }}
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: [0.8, 1, 1.15], opacity: [0, 0.6, 0] }}
                transition={{
                  duration: 1.5,
                  delay: 0.8,
                  repeat: 1,
                  ease: "easeOut",
                }}
              />
              <motion.div
                className="absolute inset-0 rounded-2xl border-2"
                style={{ borderColor: pulseColor }}
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: [0.8, 1, 1.25], opacity: [0, 0.4, 0] }}
                transition={{
                  duration: 1.5,
                  delay: 1.0,
                  repeat: 1,
                  ease: "easeOut",
                }}
              />
            </motion.div>

            {/* Credit Card */}
            <motion.div
              className="absolute w-56 h-36 rounded-xl shadow-2xl overflow-hidden"
              initial={{ x: 100, y: -80, rotate: -20, opacity: 0 }}
              animate={{
                x: [100, 0, 0, 0],
                y: [-80, 0, -6, 0],
                rotate: [-20, 0, 0, 0],
                opacity: [0, 1, 1, 1],
              }}
              transition={{
                duration: 1.2,
                times: [0, 0.4, 0.55, 0.7],
                ease: "easeInOut",
                delay: 0.3,
              }}
            >
              <div className="w-full h-full bg-gradient-to-br from-[#FF3621] via-[#FF6F61] to-[#FF3621] p-4 flex flex-col justify-between">
                <div className="flex justify-between items-start">
                  <div className="w-10 h-7 rounded-md bg-gradient-to-br from-yellow-300 to-yellow-500 opacity-80" />
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    className="text-white/70"
                  >
                    <path
                      d="M2 9.5a5 5 0 017.07-7.07"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                    <path
                      d="M5 12a2.5 2.5 0 013.54-3.54"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                    <circle cx="9" cy="14" r="1.5" fill="currentColor" />
                  </svg>
                </div>
                <div className="text-white/90 font-mono text-sm tracking-widest">
                  •••• •••• •••• {lastFour}
                </div>
                <div className="flex justify-between items-end">
                  <span className="text-white/70 text-xs font-medium uppercase tracking-wide">
                    {cardholderName}
                  </span>
                  <span className="text-white/60 text-xs font-mono">
                    DATABRICKS
                  </span>
                </div>
              </div>
            </motion.div>

            {/* Result icon + message */}
            <motion.div
              className="flex flex-col items-center gap-3"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 2.0, duration: 0.4 }}
            >
              <motion.div
                className="w-16 h-16 rounded-full flex items-center justify-center"
                style={{ backgroundColor: accentColor }}
                initial={{ scale: 0 }}
                animate={{ scale: [0, 1.2, 1] }}
                transition={{ delay: 2.0, duration: 0.5, ease: "easeOut" }}
              >
                {declined ? (
                  <svg
                    width="32"
                    height="32"
                    viewBox="0 0 24 24"
                    fill="none"
                    className="text-white"
                  >
                    <motion.path
                      d="M18 6L6 18"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                      initial={{ pathLength: 0 }}
                      animate={{ pathLength: 1 }}
                      transition={{ delay: 2.2, duration: 0.3 }}
                    />
                    <motion.path
                      d="M6 6l12 12"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                      initial={{ pathLength: 0 }}
                      animate={{ pathLength: 1 }}
                      transition={{ delay: 2.35, duration: 0.3 }}
                    />
                  </svg>
                ) : (
                  <svg
                    width="32"
                    height="32"
                    viewBox="0 0 24 24"
                    fill="none"
                    className="text-white"
                  >
                    <motion.path
                      d="M5 13l4 4L19 7"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      initial={{ pathLength: 0 }}
                      animate={{ pathLength: 1 }}
                      transition={{ delay: 2.2, duration: 0.4 }}
                    />
                  </svg>
                )}
              </motion.div>

              <motion.span
                className="text-white text-lg font-semibold"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 2.4 }}
              >
                {declined ? "Transaction Declined" : "Transaction Approved"}
              </motion.span>

              {fraudProbability !== undefined && (
                <motion.span
                  className="text-white/60 text-xs font-mono"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 2.5 }}
                >
                  Fraud probability: {(fraudProbability * 100).toFixed(2)}%
                </motion.span>
              )}

              {declined && declineReason && (
                <motion.div
                  className="max-w-sm text-center px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/20"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 2.6 }}
                >
                  <span className="text-red-300 text-sm">{declineReason}</span>
                </motion.div>
              )}

              {/* Latency Waterfall */}
              {latency && (
                <motion.div
                  className="w-[380px] mt-2 rounded-lg bg-white/5 border border-white/10 p-4 space-y-[6px]"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 2.8, duration: 0.4 }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center gap-2 mb-3">
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      className="text-white/40"
                    >
                      <circle
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="2"
                      />
                      <path
                        d="M12 6v6l4 2"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                      />
                    </svg>
                    <span className="text-[11px] font-semibold text-white/60 uppercase tracking-wider">
                      Latency Breakdown
                    </span>
                  </div>

                  {latency.modelTotalMs !== undefined && (
                    <LatencyRow
                      label="Model Inference"
                      ms={latency.modelTotalMs}
                      maxMs={maxMs}
                      color="#FF3621"
                      indent={8}
                    />
                  )}
                  {latency.modelLookupMs !== undefined && (
                    <LatencyRow
                      label="Feature Lookup"
                      ms={latency.modelLookupMs}
                      maxMs={maxMs}
                      color="#F59E0B"
                      indent={16}
                    />
                  )}
                  {latency.modelInferenceMs !== undefined && (
                    <LatencyRow
                      label="Model Prediction"
                      ms={latency.modelInferenceMs}
                      maxMs={maxMs}
                      color="#00A972"
                      indent={16}
                    />
                  )}
                  {latency.businessLogicMs !== undefined && (
                    <LatencyRow
                      label="Business Logic"
                      ms={latency.businessLogicMs}
                      maxMs={maxMs}
                      color="#6CB6FF"
                      indent={8}
                    />
                  )}
                </motion.div>
              )}

              <motion.span
                className="text-white/50 text-sm mt-1"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: latency ? 3.2 : declined ? 2.8 : 2.6 }}
              >
                Tap anywhere to dismiss
              </motion.span>
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
