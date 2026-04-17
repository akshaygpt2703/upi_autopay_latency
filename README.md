# UPI Autopay Latency Test

Internal tool to measure BSE Star MF UPI Autopay collect → approval latency.

## Setup

```bash
npm install
cp .env.example .env.local
# fill in the 6 env vars in .env.local
npm run dev
```

## Supabase tables



-- Logs
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
```

## Row-level security

Since this tool uses the anon key from the browser, either:

- Disable RLS on `upi_test_clients` and `upi_latency_logs` (simplest for internal tool running on localhost), OR
- Enable RLS and add permissive policies scoped to your auth setup.

For MVP on localhost with internal data, disabling RLS is fine.

## Env vars (`.env.local`)

```
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=...
VITE_BSE_USER_ID=2972401
VITE_BSE_MEMBER_ID=29724
VITE_BSE_PASSWORD=...
VITE_BSE_PASSKEY=...
```

## Flow

1. Pick client from dropdown, enter UPI ID
2. Click **Send Collect Request**
   - `getPassword` → encrypted session token
   - `MFAPI` Flag=19 with pipe-separated param
   - On `101 FAILED: PASSWORD EXPIRED`, auto-refreshes token and retries once
   - T1, request, response, mandate_id logged to `upi_latency_logs`
3. When push lands, click **I got the notification** → records T2
4. After entering UPI PIN, click **I approved the mandate** → records T3
5. T4 (polling) will slot in once mandate status API is wired up

## What's not done yet

- T4 polling against mandate status API
- Past-runs history list
- RLS policies
