import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from './lib/supabase.js';
import { op } from './lib/openpanel.js';
import {
  getBsePassword,
  getBseAccessToken,
  submitCollectRequest,
  buildUpiMandateParam,
  fetchMandateDetails,
  parseMandateStatus,
  isAccessTokenExpired
} from './lib/bse.js';

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 60;

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString('en-IN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  });
}

function fmtClockTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const hours24 = d.getHours();
  const hours = String(hours24 % 12 || 12).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  const ampm = hours24 >= 12 ? 'PM' : 'AM';
  return `${hours}:${minutes}:${seconds} ${ampm}`;
}

function diffSec(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  return ((new Date(toIso) - new Date(fromIso)) / 1000).toFixed(2);
}

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/* ------------------------------------------------------------------ */
/* Component                                                          */
/* ------------------------------------------------------------------ */

export default function App() {
  // Form state
  const [clients, setClients] = useState([]);
  const [loadingClients, setLoadingClients] = useState(true);
  const [clientCode, setClientCode] = useState('');
  const [upiId, setUpiId] = useState('');

  // Run state
  const [runRef, setRunRef] = useState(null);
  const [logId, setLogId] = useState(null);
  const [mandateId, setMandateId] = useState(null);
  const [collectStatus, setCollectStatus] = useState(null); // 'sending' | 'success' | 'failed'
  const [collectError, setCollectError] = useState(null);
  const [rawResponse, setRawResponse] = useState(null);

  // Timestamps (ISO strings)
  const [t1, setT1] = useState(null);
  const [t2, setT2] = useState(null);
  const [t3, setT3] = useState(null);
  const [t4, setT4] = useState(null);

  // T4 polling
  const [pollAttempts, setPollAttempts] = useState(0);
  const [pollStatus, setPollStatus] = useState(null); // 'polling' | 'confirmed' | 'rejected' | 'timeout' | 'failed'
  const [finalMandateStatus, setFinalMandateStatus] = useState(null); // 'APPROVED' | 'REJECTED' | ...
  const [finalRemarks, setFinalRemarks] = useState(null);
  const pollCancelRef = useRef({ cancelled: false });

  // Elapsed ticker
  const [now, setNow] = useState(Date.now());
  const tickerRef = useRef(null);

  const selectedClient = useMemo(
    () => clients.find((c) => c.client_code === clientCode) || null,
    [clients, clientCode]
  );

  /* -------------------- Load clients on mount -------------------- */
  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from('upi_test_clients')
        .select('*')
        .order('name', { ascending: true });
      if (error) {
        console.error('Failed to load clients', error);
      } else {
        setClients(data || []);
      }
      setLoadingClients(false);
    })();
  }, []);

  /* -------------------- Elapsed ticker while run active -------------------- */
  useEffect(() => {
    if (t1 && !t3) {
      tickerRef.current = setInterval(() => setNow(Date.now()), 250);
      return () => clearInterval(tickerRef.current);
    }
  }, [t1, t3]);

  /* -------------------- T4 polling driver (invoked from handleApproved) -------------------- */
  async function startMandateStatusPolling({ client, mandateId: mid, logId: lid, collectResponseAt }) {
    // Cancel any previous poll loop before starting a new one
    pollCancelRef.current.cancelled = true;
    const cancelRef = { cancelled: false };
    pollCancelRef.current = cancelRef;

    setPollStatus('polling');
    setPollAttempts(0);
    setFinalMandateStatus(null);
    setFinalRemarks(null);

    let attempts = 0;
    let accessToken;

    // MandateDetails needs a separate access token from the collect/getPassword one.
    try {
      accessToken = await getBseAccessToken('Mandate');
    } catch (err) {
      console.error('GetAccessToken failed', err);
      if (!cancelRef.cancelled) setPollStatus('failed');
      return;
    }

    while (!cancelRef.cancelled && attempts < POLL_MAX_ATTEMPTS) {
      attempts += 1;
      setPollAttempts(attempts);

      try {
        let result = await fetchMandateDetails({
          token: accessToken,
          client,
          mandateId: mid
        });

        // Access token can expire mid-poll — refresh once and retry the same attempt.
        if (isAccessTokenExpired(result.parsed)) {
          accessToken = await getBseAccessToken('Mandate');
          result = await fetchMandateDetails({
            token: accessToken,
            client,
            mandateId: mid
          });
        }

        const pollAt = new Date().toISOString();
        const classification = parseMandateStatus({
          fullXml: result.responseText,
          raw: result.raw
        });

        if (classification.terminal) {
          if (!cancelRef.cancelled) {
            setT4(pollAt);
            setPollStatus(classification.status === 'success' ? 'confirmed' : 'rejected');
            setFinalMandateStatus(classification.mandateStatus);
            setFinalRemarks(classification.remarks);
          }
          const latencyMs = new Date(pollAt) - new Date(collectResponseAt);
          op.track('latency_measured', {
            ms: latencyMs,
            status: classification.status === 'success' ? 'success' : 'failure',
            mandate_method: 'upi_autopay',
          });

          await supabase
            .from('upi_latency_logs')
            .update({
              status_request: { envelope: result.requestEnvelope },
              status_response: { raw: result.raw, fullXml: result.responseText },
              status_confirmed_at: pollAt,
              final_status: classification.status,
              poll_count: attempts,
              notes: classification.remarks || null
            })
            .eq('id', lid);
          return;
        }

        // Non-terminal poll: persist latest raw + attempt count, keep polling
        await supabase
          .from('upi_latency_logs')
          .update({
            status_request: { envelope: result.requestEnvelope },
            status_response: { raw: result.raw, fullXml: result.responseText },
            poll_count: attempts
          })
          .eq('id', lid);
      } catch (err) {
        console.error('MandateDetails poll failed', err);
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    if (!cancelRef.cancelled) {
      const timeoutMs = Date.now() - new Date(collectResponseAt);
      op.track('latency_measured', {
        ms: timeoutMs,
        status: 'timeout',
        mandate_method: 'upi_autopay',
      });

      setPollStatus('timeout');
      await supabase
        .from('upi_latency_logs')
        .update({ final_status: 'timeout', poll_count: attempts })
        .eq('id', lid);
    }
  }

  /* -------------------- Send collect request -------------------- */
  async function handleSendCollect() {
    if (!selectedClient || !upiId.trim()) return;

    // Reset run state
    const newRunRef = crypto.randomUUID();
    setRunRef(newRunRef);
    setLogId(null);
    setMandateId(null);
    setCollectStatus('sending');
    setCollectError(null);
    setRawResponse(null);
    setT1(null);
    setT2(null);
    setT3(null);

    const param = buildUpiMandateParam({ client: selectedClient, upiId: upiId.trim() });

    // Insert log row BEFORE the call so we always have a record
    const sentAt = new Date().toISOString();

    const { data: insertData, error: insertError } = await supabase
      .from('upi_latency_logs')
      .insert({
        run_ref: newRunRef,
        client_code: selectedClient.client_code,
        upi_id: upiId.trim(),
        collect_request: { param, flag: '19' },
        collect_sent_at: sentAt
      })
      .select('id')
      .single();

    if (insertError) {
      setCollectStatus('failed');
      setCollectError(`Supabase insert failed: ${insertError.message}`);
      return;
    }
    setLogId(insertData.id);

    // Fire collect request (getPassword first, then MFAPI with retry-on-expired)
    try {
      const token = await getBsePassword();
      const result = await submitCollectRequest({ token, param });
      const respAt = new Date().toISOString();

      // T1 starts only once the response is back
      setT1(respAt);
      setRawResponse(result.parsed.raw || result.responseText);

      // Update log row with response + mandate_id (or failure)
      await supabase
        .from('upi_latency_logs')
        .update({
          collect_response: {
            raw: result.parsed.raw,
            statusCode: result.parsed.statusCode,
            message: result.parsed.message,
            data: result.parsed.data,
            retried: result.retried,
            fullXml: result.responseText
          },
          collect_response_at: respAt,
          mandate_id: result.mandateId,
          final_status: result.mandateId ? null : 'error',
          notes: result.retried ? 'Password refreshed mid-run' : null
        })
        .eq('id', insertData.id);

      if (result.mandateId) {
        setMandateId(result.mandateId);
        setCollectStatus('success');
      } else {
        setCollectStatus('failed');
        setCollectError(
          `BSE: ${result.parsed.statusCode || '?'} · ${result.parsed.message || 'Unknown error'}`
        );
      }
    } catch (err) {
      const respAt = new Date().toISOString();
      setCollectStatus('failed');
      setCollectError(err.message || String(err));
      await supabase
        .from('upi_latency_logs')
        .update({
          collect_response: { error: err.message || String(err) },
          collect_response_at: respAt,
          final_status: 'error'
        })
        .eq('id', insertData.id);
    }
  }

  /* -------------------- Capture T2 -------------------- */
  async function handleNotified() {
    if (!logId || t2) return;
    const ts = new Date().toISOString();
    setT2(ts);
    await supabase
      .from('upi_latency_logs')
      .update({ notification_at: ts })
      .eq('id', logId);
  }

  /* -------------------- Capture T3 & kick off MandateDetails polling -------------------- */
  async function handleApproved() {
    if (!logId || t3) return;
    const ts = new Date().toISOString();
    setT3(ts);
    await supabase
      .from('upi_latency_logs')
      .update({ user_approved_at: ts })
      .eq('id', logId);

    // Fire the MandateDetails polling only after this click
    if (selectedClient && mandateId) {
      startMandateStatusPolling({ client: selectedClient, mandateId, logId, collectResponseAt: t1 });
    }
  }

  /* -------------------- Reset for new run -------------------- */
  function handleReset() {
    // Cancel any in-flight polling loop from the previous run
    pollCancelRef.current.cancelled = true;

    setRunRef(null);
    setLogId(null);
    setMandateId(null);
    setCollectStatus(null);
    setCollectError(null);
    setRawResponse(null);
    setT1(null);
    setT2(null);
    setT3(null);
    setT4(null);
    setPollAttempts(0);
    setPollStatus(null);
    setFinalMandateStatus(null);
    setFinalRemarks(null);
    setUpiId('');
  }

  /* -------------------- Render -------------------- */
  const elapsedMs = t1 ? (t3 ? new Date(t3) - new Date(t1) : now - new Date(t1)) : 0;
  const canStart = !!selectedClient && !!upiId.trim() && collectStatus !== 'sending';
  const runActive = !!t1;

  return (
    <div className="min-h-screen bg-soft-bg">
      <div className="mx-auto max-w-7xl px-6 py-10">
        {/* Header */}
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-ink">UPI Autopay Latency Test</h1>
        </header>

        {/* Step cards — always side-by-side, gated by progress */}
        <div className="grid grid-cols-3 gap-6 items-start">
          {/* 1. Setup card */}
          <section className="rounded-2xl border border-border bg-white p-6 shadow-sm">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
              1 · Setup
            </h2>

            <div className="mt-4 space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-ink">Client</label>
                <select
                  value={clientCode}
                  onChange={(e) => setClientCode(e.target.value)}
                  disabled={loadingClients || runActive}
                  className="w-full rounded-lg border border-border bg-white px-3 py-2.5 text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:bg-soft-bg disabled:text-muted"
                >
                  <option value="">
                    {loadingClients ? 'Loading…' : 'Select a client'}
                  </option>
                  {clients.map((c) => (
                    <option key={c.client_code} value={c.client_code}>
                      {c.client_code} — {c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-ink">UPI ID</label>
                <input
                  type="text"
                  value={upiId}
                  onChange={(e) => setUpiId(e.target.value)}
                  placeholder="e.g. 7017446538@pthdfc"
                  disabled={runActive}
                  className="w-full rounded-lg border border-border bg-white px-3 py-2.5 text-sm text-ink placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:bg-soft-bg disabled:text-muted"
                />
              </div>
            </div>

            {selectedClient && (
              <div className="mt-4 rounded-lg bg-soft-bg p-4">
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                  <dt className="font-medium text-muted">Account number</dt>
                  <dd className="font-mono text-ink">{selectedClient.bnk1_acc_no}</dd>
                  <dt className="font-medium text-muted">IFSC code</dt>
                  <dd className="font-mono text-ink">{selectedClient.bnk1_ifsc}</dd>
                </dl>
                <p className="mt-3 border-t border-border pt-3 text-xs italic text-muted">
                  For testing purposes, mandate amount and end date are fixed.
                </p>
              </div>
            )}

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <button
                onClick={handleSendCollect}
                disabled={!canStart || runActive}
                className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:bg-border disabled:text-muted"
              >
                {collectStatus === 'sending' ? 'Sending…' : 'Send Collect Request'}
              </button>
              {runActive && (
                <button
                  onClick={handleReset}
                  className="rounded-lg border border-border bg-white px-4 py-2.5 text-sm font-medium text-ink transition hover:bg-soft-bg"
                >
                  New test
                </button>
              )}
            </div>
          </section>

          {/* 2. Live run card */}
          <section
            className={`rounded-2xl border border-border bg-white p-6 shadow-sm ${
              runActive ? '' : 'pointer-events-none opacity-50'
            }`}
            aria-disabled={!runActive}
          >
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
                2 · Live run
              </h2>
              {runActive && <StatusPill status={collectStatus} />}
            </div>

            {runActive ? (
              <>
                <div className="mt-2 flex items-baseline gap-3">
                  <span className="font-mono text-3xl font-semibold text-ink tabular-nums">
                    {fmtElapsed(elapsedMs)}
                  </span>
                  <span className="text-xs text-muted">elapsed since T1</span>
                </div>

                {mandateId && (
                  <div className="mt-4 rounded-lg bg-soft-bg p-3">
                    <div className="text-xs uppercase tracking-wider text-muted">Mandate ID</div>
                    <div className="mt-0.5 font-mono text-lg text-ink">{mandateId}</div>
                  </div>
                )}

                {collectError && (
                  <div className="mt-4 rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-danger">
                    <div className="font-semibold">Collect failed</div>
                    <div className="mt-0.5 font-mono text-xs">{collectError}</div>
                  </div>
                )}

                {mandateId && (
                  <div className="mt-5 space-y-3">
                    <StepButton
                      label="I got the notification"
                      hint="Record T2"
                      tone="notification"
                      onClick={handleNotified}
                      done={!!t2}
                      disabled={!!t2}
                      timestamp={t2}
                    />
                    <StepButton
                      label="I approved the mandate"
                      hint="Record T3"
                      tone="approval"
                      onClick={handleApproved}
                      done={!!t3}
                      disabled={!t2 || !!t3}
                      timestamp={t3}
                    />
                  </div>
                )}
              </>
            ) : (
              <p className="mt-4 text-sm italic text-muted">
                Send a collect request to begin.
              </p>
            )}
          </section>

          {/* 3. Polling card */}
          <section
            className={`rounded-2xl border border-border bg-white p-6 shadow-sm ${
              t3 ? '' : 'pointer-events-none opacity-50'
            }`}
            aria-disabled={!t3}
          >
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
              3 · Polling
            </h2>

            {t3 ? (
              <>
                <PollingStatusBlock
                  pollStatus={pollStatus}
                  pollAttempts={pollAttempts}
                  finalMandateStatus={finalMandateStatus}
                  finalRemarks={finalRemarks}
                />
              </>
            ) : (
              <p className="mt-4 text-sm italic text-muted">
                Polling starts once you approve the mandate.
              </p>
            )}
          </section>
        </div>

        {/* Timestamps & latencies — horizontal row below the 3 cards */}
        {t1 && (
          <div className="mt-6 grid grid-cols-4 gap-4">
            <TimestampCard label="T1 · Collect sent" ts={t1} />
            <TimestampCard
              label="T2 · Notification received"
              ts={t2}
              delta={diffSec(t1, t2)}
              deltaLabel="notification latency"
            />
            <TimestampCard
              label="T3 · User approved"
              ts={t3}
              delta={diffSec(t2, t3)}
              deltaLabel="user decision time"
            />
            <TimestampCard
              label="T4 · Status confirmed"
              ts={t4}
              delta={diffSec(t3, t4)}
              deltaLabel="status confirmation"
            />
          </div>
        )}

        {t1 && (t3 || t4) && (
          <div className="mt-4 rounded-lg bg-primary/5 p-4">
            <div className="text-xs uppercase tracking-wider text-primary">
              Total T1 → {t4 ? 'T4' : 'T3'}
            </div>
            <div className="mt-1 font-mono text-2xl font-semibold text-ink tabular-nums">
              {diffSec(t1, t4 || t3)}s
            </div>
          </div>
        )}

        {rawResponse && (
          <details className="mt-6">
            <summary className="cursor-pointer text-xs font-medium text-muted hover:text-ink">
              Raw BSE collect response
            </summary>
            <pre className="mt-2 overflow-x-auto rounded-lg bg-ink p-3 font-mono text-xs text-white">
              {rawResponse}
            </pre>
          </details>
        )}

        {runRef && (
          <footer className="mt-8 text-center text-xs text-muted">
            run_ref · <span className="font-mono">{runRef}</span>
          </footer>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Presentational bits                                                */
/* ------------------------------------------------------------------ */

function StatusPill({ status }) {
  const map = {
    sending: { label: 'Sending', cls: 'bg-warning/10 text-warning' },
    success: { label: 'Collect OK', cls: 'bg-success/10 text-success' },
    failed: { label: 'Failed', cls: 'bg-danger/10 text-danger' }
  };
  const m = map[status];
  if (!m) return null;
  return (
    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${m.cls}`}>
      {m.label}
    </span>
  );
}

const STEP_TONES = {
  notification: {
    idle: 'border-warning/40 bg-warning/5 hover:border-warning hover:bg-warning/10',
    iconBg: 'bg-warning/10 text-warning',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="h-5 w-5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75V9a6 6 0 00-12 0v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
      </svg>
    )
  },
  approval: {
    idle: 'border-border bg-white hover:border-primary hover:bg-primary/5',
    iconBg: 'bg-soft-bg text-muted',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="h-5 w-5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    )
  }
};

function StepButton({ label, hint, onClick, done, disabled, timestamp, tone = 'notification' }) {
  const t = STEP_TONES[tone];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full rounded-xl border p-4 text-left transition ${
        done
          ? 'border-success/40 bg-success/10'
          : disabled
          ? 'border-border bg-soft-bg opacity-60'
          : t.idle
      }`}
    >
      <div className="flex items-start gap-3">
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
            done ? 'bg-success/15 text-success' : t.iconBg
          }`}
        >
          {done ? (
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="h-5 w-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
          ) : (
            t.icon
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-ink">{label}</div>
          <div className="mt-0.5 text-xs text-muted">{hint}</div>
          {timestamp && (
            <div className="mt-2 font-mono text-xs text-ink">{fmtTime(timestamp)}</div>
          )}
        </div>
      </div>
    </button>
  );
}

function PollingStatusBlock({ pollStatus, pollAttempts, finalMandateStatus, finalRemarks }) {
  if (pollStatus === 'polling') {
    return (
      <div className="mt-4 flex flex-col items-center justify-center rounded-lg border border-primary/30 bg-primary/5 px-3 py-6">
        <svg
          className="h-10 w-10 animate-spin text-primary"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            className="opacity-20"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-90"
            fill="currentColor"
            d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
          />
        </svg>
        <div className="mt-3 text-sm font-medium text-ink">
          Waiting for autopay mandate
        </div>
        <div className="mt-1 text-xs text-muted">
          Attempt {pollAttempts} / {POLL_MAX_ATTEMPTS} · every {POLL_INTERVAL_MS / 1000}s
        </div>
      </div>
    );
  }
  if (pollStatus === 'confirmed') {
    return (
      <div className="mt-4 rounded-lg border border-success/30 bg-success/5 p-3">
        <div className="text-xs font-semibold uppercase tracking-wider text-success">
          Mandate {finalMandateStatus || 'APPROVED'}
        </div>
        <div className="mt-1 text-xs text-muted">
          Confirmed on poll {pollAttempts} of {POLL_MAX_ATTEMPTS}
        </div>
      </div>
    );
  }
  if (pollStatus === 'rejected') {
    return (
      <div className="mt-4 rounded-lg border border-danger/30 bg-danger/5 p-3">
        <div className="text-xs font-semibold uppercase tracking-wider text-danger">
          Mandate {finalMandateStatus || 'REJECTED'}
        </div>
        {finalRemarks && (
          <div className="mt-1 text-xs text-ink">{finalRemarks}</div>
        )}
        <div className="mt-1 text-xs text-muted">
          Detected on poll {pollAttempts} of {POLL_MAX_ATTEMPTS}
        </div>
      </div>
    );
  }
  if (pollStatus === 'timeout') {
    return (
      <div className="mt-4 rounded-lg border border-warning/30 bg-warning/5 p-3">
        <div className="text-xs font-medium text-warning">Timed out</div>
        <div className="mt-1 text-xs text-muted">
          Status not confirmed after {POLL_MAX_ATTEMPTS} polls.
        </div>
      </div>
    );
  }
  if (pollStatus === 'failed') {
    return (
      <div className="mt-4 rounded-lg border border-danger/30 bg-danger/5 p-3">
        <div className="text-xs font-medium text-danger">GetAccessToken failed</div>
        <div className="mt-1 text-xs text-muted">Check console for details.</div>
      </div>
    );
  }
  return null;
}

function TimestampCard({ label, ts, delta, deltaLabel }) {
  return (
    <div className="rounded-lg border border-border bg-soft-bg p-3">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="mt-2 font-mono text-lg text-ink tabular-nums">{fmtClockTime(ts)}</div>
      {delta != null && (
        <div className="mt-1 text-xs text-muted">
          +{delta}s {deltaLabel}
        </div>
      )}
    </div>
  );
}
