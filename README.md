# UPI Autopay Latency Test

Internal tool for measuring end-to-end latency of UPI Autopay mandate registration via BSE Star MF.

**Live:** https://upi-autopay-latency.vercel.app/

## What it measures

Four timestamps captured during a single mandate registration flow:

| | Event | Source |
|---|---|---|
| **T1** | Collect request sent to BSE | Server call |
| **T2** | Push notification received on user's phone | User taps button |
| **T3** | User approves mandate with UPI PIN | User taps button |
| **T4** | Status confirmed by BSE | Polled every 3s |

Derived latencies:

- **T1 → T2** — notification delivery (BSE → NPCI → PSP → device)
- **T2 → T3** — user decision time (baseline only, not optimizable)
- **T3 → T4** — status propagation (how quickly BSE sees the approval)
- **T1 → T4** — total end-to-end

## Tech stack

- Vite + React 18 (no TypeScript)
- Tailwind CSS with VRFA design tokens
- Supabase (client_id + publishable key, direct browser calls)
- BSE Star MF SOAP API (getPassword + MFAPI Flag=19 + mandate status polling)
- Deployed on Vercel with a rewrite to proxy `/bse/*` → `bsestarmf.in` (bypasses browser CORS)

## Project structure

```
upi-latency-test/
├── index.html
├── vite.config.js        # dev proxy for /bse (local CORS bypass)
├── vercel.json           # production proxy for /bse
├── tailwind.config.js    # VRFA design tokens
├── .env.example          # required env vars
└── src/
    ├── main.jsx
    ├── App.jsx           # full page UI + state machine
    ├── index.css
    └── lib/
        ├── supabase.js   # Supabase client
        └── bse.js        # SOAP helpers: getPassword, collect, status poll
```

## Running locally

**Prerequisites:** Node 20+, a Supabase project, BSE UAT/prod credentials.

```bash
git clone https://github.com/akshaygpt2703/upi-autopay-latency.git
cd upi-autopay-latency
npm install
cp .env.example .env.local
# fill in the 6 env vars
npm run dev
```

Open http://localhost:5173.

### Environment variables

```
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=

VITE_BSE_USER_ID=
VITE_BSE_MEMBER_ID=
VITE_BSE_PASSWORD=
VITE_BSE_PASSKEY=
```

BSE credentials are baked into the frontend bundle. This is an internal tool — don't deploy it publicly without moving BSE calls to a serverless function or adding auth in front.

## Supabase setup

Run in SQL editor:

```sql
-- Test clients populating the dropdown
create table upi_test_clients (
  client_code   text primary key,
  name          text not null,
  bnk1_acc_typ  text not null,
  bnk1_acc_no   text not null,
  bnk1_micr     text,
  bnk1_ifsc     text not null
);

-- Seed rows (replace with your own)
insert into upi_test_clients values
  ('V01093967F', 'GULNAZ PARVEEN',   'SB', '1652010011112',      '', 'PUNB0165220'),
  ('V01093970W', 'ANKIT BHARDWAJ',   'SB', '00000038377346788',  '', 'SBIN0017556'),
  ('V01100802A', 'ASHUTOSH GUPTA',   'SB', '5157019227',         '', 'UTIB0005140'),
  ('V05144802Z', 'AKSHAY GUPTA',     'SB', '125701505423',       '', 'ICIC0001257');

-- One row per test run, updated as T1→T2→T3→T4 populate
create table upi_latency_logs (
  id                    uuid primary key default gen_random_uuid(),
  run_ref               text not null unique,
  client_code           text not null references upi_test_clients(client_code),
  upi_id                text,
  collect_request       jsonb,
  collect_response      jsonb,
  collect_sent_at       timestamptz,
  collect_response_at   timestamptz,
  mandate_id            text,
  notification_at       timestamptz,
  user_approved_at      timestamptz,
  status_request        jsonb,
  status_response       jsonb,
  status_confirmed_at   timestamptz,
  final_status          text,
  poll_count            int default 0,
  notes                 text,
  created_at            timestamptz default now()
);

create index idx_upi_logs_client_code on upi_latency_logs(client_code);
create index idx_upi_logs_mandate_id  on upi_latency_logs(mandate_id);

-- Disable RLS for internal tool (enable and add policies if exposing publicly)
alter table upi_test_clients  disable row level security;
alter table upi_latency_logs  disable row level security;
```

### Handy latency view

```sql
create or replace view v_upi_latency_metrics as
select
  id, run_ref, client_code, upi_id, mandate_id, final_status, poll_count,
  extract(epoch from (notification_at     - collect_sent_at))   as t1_to_t2_sec,
  extract(epoch from (user_approved_at    - notification_at))   as t2_to_t3_sec,
  extract(epoch from (status_confirmed_at - user_approved_at))  as t3_to_t4_sec,
  extract(epoch from (status_confirmed_at - collect_sent_at))   as total_sec,
  collect_sent_at, created_at
from upi_latency_logs
where collect_sent_at is not null
order by created_at desc;
```

## BSE integration notes

- **SOAP 1.2** — `Content-Type: application/soap+xml; charset=utf-8`
- **Response format** — pipe-separated inside `<MFAPIResult>` or `<getPasswordResult>`: `statusCode|message|data` where `100` = success
- **Password expiry** — if any call returns `101 FAILED: PASSWORD EXPIRED`, the client auto-refreshes the token via `getPassword` and retries once
- **`<wsa:To>` stays as real BSE URL** in the SOAP envelope even when the fetch URL goes through the proxy. The proxy only rewrites transport; payload content is read by BSE.
- **Flag=19** for mandate registration, Mandate Type `U` for UPI Collect. Amount is hardcoded to ₹5000 and end date to 01/04/2031.

## Deployment

Deployed on Vercel from the `main` branch. `vercel.json` handles the production equivalent of the Vite dev proxy:

```json
{
  "rewrites": [
    { "source": "/bse/:path*", "destination": "https://bsestarmf.in/:path*" }
  ]
}
```

All six `VITE_*` env vars must be added under Vercel → Project Settings → Environment Variables for production and preview environments.

## Flow

1. Pick client from dropdown (loaded from `upi_test_clients`)
2. Enter UPI ID
3. **Send Collect Request** → generates `run_ref` (UUID), inserts log row with T1 + request, calls `getPassword`, calls MFAPI Flag=19, updates log row with response + mandate_id
4. **I got the notification** → records T2
5. **I approved the mandate** → records T3, kicks off polling loop (every 3s) against mandate status API
6. Polling loops until status = `approved` / `rejected` / or 100 polls elapsed (5 min timeout)
7. T4 + final_status + poll_count written to log row
8. **New test** resets state (previous log row stays in Supabase)

## Caveats

- T2 and T3 are self-reported (user taps a button). Not the true device push-receipt time. Acceptable for baselining; not a replacement for SDK-level instrumentation.
- BSE credentials are visible in the browser bundle. Safe for internal use behind Vercel Deployment Protection; don't expose publicly without moving calls server-side.
- Polling lives in the browser tab — closing the tab stops polling. T4 won't be captured for that run.
- Amount is fixed at ₹5000 and end date at 01/04/2031 for UPI mandates.
