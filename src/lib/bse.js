// BSE Star MF SOAP client
// Direct browser calls routed through Vite dev proxy (/bse → https://bsestarmf.in)

// Browser sends here (Vite forwards to BSE server-side, bypasses CORS)
const BSE_FETCH_URL = '/bse/StarMFWebService/StarMFWebService.svc/Secure';

// BSE server reads this from inside the SOAP envelope — must be the real URL
const BSE_SOAP_TO = 'https://bsestarmf.in/StarMFWebService/StarMFWebService.svc/Secure';

const env = {
  userId: import.meta.env.VITE_BSE_USER_ID,
  memberId: import.meta.env.VITE_BSE_MEMBER_ID,
  password: import.meta.env.VITE_BSE_PASSWORD,
  passKey: import.meta.env.VITE_BSE_PASSKEY
};

/* ------------------------------------------------------------------ */
/* SOAP envelope builders                                             */
/* ------------------------------------------------------------------ */

function buildGetAccessTokenEnvelope({ requestType }) {
  return `<soap:Envelope xmlns:soap='http://www.w3.org/2003/05/soap-envelope' xmlns:bses='http://www.bsestarmf.in/2016/01/' xmlns:star='http://schemas.datacontract.org/2004/07/StarMFWebService'>
    <soap:Header xmlns:wsa='http://www.w3.org/2005/08/addressing'>
      <wsa:Action>http://www.bsestarmf.in/2016/01/IStarMFWebService/GetAccessToken</wsa:Action>
      <wsa:To>${BSE_SOAP_TO}</wsa:To>
    </soap:Header>
    <soap:Body>
      <bses:GetAccessToken>
        <bses:Param>
          <star:MemberId>${env.memberId}</star:MemberId>
          <star:PassKey>${env.passKey}</star:PassKey>
          <star:Password>${env.password}</star:Password>
          <star:RequestType>${requestType}</star:RequestType>
          <star:UserId>${env.userId}</star:UserId>
        </bses:Param>
      </bses:GetAccessToken>
    </soap:Body>
  </soap:Envelope>`;
}

function buildGetPasswordEnvelope() {
  return `<soap:Envelope xmlns:soap='http://www.w3.org/2003/05/soap-envelope' xmlns:ns='http://www.bsestarmf.in/2016/01/'>
    <soap:Header xmlns:wsa='http://www.w3.org/2005/08/addressing'>
      <wsa:Action>http://www.bsestarmf.in/2016/01/IStarMFWebService/getPassword</wsa:Action>
      <wsa:To>${BSE_SOAP_TO}</wsa:To>
    </soap:Header>
    <soap:Body>
      <ns:getPassword>
        <ns:UserId>${env.userId}</ns:UserId>
        <ns:MemberId>${env.memberId}</ns:MemberId>
        <ns:Password>${env.password}</ns:Password>
        <ns:PassKey>${env.passKey}</ns:PassKey>
      </ns:getPassword>
    </soap:Body>
  </soap:Envelope>`;
}


function buildMandateDetailsEnvelope({
  clientCode,
  encryptedPassword,
  fromDate,
  mandateId,
  memberCode,
  toDate
}) {
  return `<soap:Envelope xmlns:soap='http://www.w3.org/2003/05/soap-envelope' xmlns:bses='http://www.bsestarmf.in/2016/01/' xmlns:star='http://schemas.datacontract.org/2004/07/StarMFWebService'>
    <soap:Header xmlns:wsa='http://www.w3.org/2005/08/addressing'>
      <wsa:Action>http://www.bsestarmf.in/2016/01/IStarMFWebService/MandateDetails</wsa:Action>
      <wsa:To>${BSE_SOAP_TO}</wsa:To>
    </soap:Header>
    <soap:Body>
      <bses:MandateDetails>
        <bses:Param>
          <star:ClientCode>${clientCode}</star:ClientCode>
          <star:EncryptedPassword>${encryptedPassword}</star:EncryptedPassword>
          <star:FromDate>${fromDate}</star:FromDate>
          <star:MandateId>${mandateId}</star:MandateId>
          <star:MemberCode>${memberCode}</star:MemberCode>
          <star:ToDate>${toDate}</star:ToDate>
        </bses:Param>
      </bses:MandateDetails>
    </soap:Body>
  </soap:Envelope>`;
}

function buildMFAPIEnvelope({ encryptedPassword, flag, param }) {
  return `<soap:Envelope xmlns:soap='http://www.w3.org/2003/05/soap-envelope' xmlns:ns='http://www.bsestarmf.in/2016/01/'>
    <soap:Header xmlns:wsa='http://www.w3.org/2005/08/addressing'>
      <wsa:Action>http://www.bsestarmf.in/2016/01/IStarMFWebService/MFAPI</wsa:Action>
      <wsa:To>${BSE_SOAP_TO}</wsa:To>
    </soap:Header>
    <soap:Body>
      <ns:MFAPI>
        <ns:Flag>${flag}</ns:Flag>
        <ns:UserId>${env.userId}</ns:UserId>
        <ns:EncryptedPassword>${encryptedPassword}</ns:EncryptedPassword>
        <ns:param>${param}</ns:param>
      </ns:MFAPI>
    </soap:Body>
  </soap:Envelope>`;
}

/* ------------------------------------------------------------------ */
/* Response parsers                                                   */
/* ------------------------------------------------------------------ */

function extractResultText(xmlText, localName) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  // Namespace-agnostic match so prefixes like <b:ResponseString> also work
  const nodes = doc.getElementsByTagNameNS('*', localName);
  return nodes[0]?.textContent?.trim() ?? null;
}

function parsePipeResult(raw) {
  if (!raw) return { statusCode: null, message: null, data: null, raw };
  const [statusCode, message = '', data = ''] = raw.split('|');
  return { statusCode, message, data, raw };
}

function isPasswordExpired(parsed) {
  return (
    parsed.statusCode !== '100' &&
    (parsed.message || '').toUpperCase().includes('PASSWORD EXPIRED')
  );
}

export function isAccessTokenExpired(parsed) {
  if (!parsed) return false;
  const msg = ((parsed.message || '') + ' ' + (parsed.raw || '')).toUpperCase();
  return /ACCESS TOKEN (EXPIRED|INVALID)/.test(msg);
}

/* ------------------------------------------------------------------ */
/* Low-level HTTP                                                     */
/* ------------------------------------------------------------------ */

async function soapPost(envelope) {
  const res = await fetch(BSE_FETCH_URL, {   // ← changed
    method: 'POST',
    headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
    body: envelope
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

/* ------------------------------------------------------------------ */
/* Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Call GetAccessToken for a given request type (e.g. 'Mandate').
 * Response is nested: <GetAccessTokenResult>{<ResponseString>, <Status>}</GetAccessTokenResult>
 * Returns the encrypted access token string.
 */
export async function getBseAccessToken(requestType = 'Mandate') {
  const envelope = buildGetAccessTokenEnvelope({ requestType });
  const { text } = await soapPost(envelope);
  const responseString = extractResultText(text, 'ResponseString');
  const status = extractResultText(text, 'Status');
  if (status !== '100' || !responseString) {
    throw new Error(`GetAccessToken failed (status=${status}): ${responseString || text}`);
  }
  return responseString;
}

/**
 * Call getPassword and return the encrypted session token.
 */
export async function getBsePassword() {
  const envelope = buildGetPasswordEnvelope();
  const { text } = await soapPost(envelope);
  const raw = extractResultText(text, 'getPasswordResult');
  const parsed = parsePipeResult(raw);

  if (parsed.statusCode !== '100') {
    throw new Error(`getPassword failed: ${raw ?? text}`);
  }
  // getPassword response is `100|TOKEN` — token is the 2nd field
  return parsed.message;
}

/**
 * Submit the UPI mandate collect request (Flag=19, Mandate Type='U').
 * Handles one retry on PASSWORD EXPIRED by refreshing the token.
 *
 * Returns:
 *   {
 *     token,                  // the token actually used
 *     requestEnvelope,        // the exact XML we sent (final attempt)
 *     responseText,           // raw XML response (final attempt)
 *     parsed,                 // { statusCode, message, data, raw }
 *     mandateId,              // string | null (only on success)
 *     retried                 // boolean — true if we refreshed password
 *   }
 */
export async function submitCollectRequest({ token, param }) {
  let currentToken = token;
  let retried = false;

  let requestEnvelope = buildMFAPIEnvelope({
    encryptedPassword: currentToken,
    flag: '19',
    param
  });
  let { text: responseText } = await soapPost(requestEnvelope);
  let raw = extractResultText(responseText, 'MFAPIResult');
  let parsed = parsePipeResult(raw);

  if (isPasswordExpired(parsed)) {
    currentToken = await getBsePassword();
    retried = true;
    requestEnvelope = buildMFAPIEnvelope({
      encryptedPassword: currentToken,
      flag: '19',
      param
    });
    ({ text: responseText } = await soapPost(requestEnvelope));
    raw = extractResultText(responseText, 'MFAPIResult');
    parsed = parsePipeResult(raw);
  }

  const mandateId = parsed.statusCode === '100' ? parsed.data || null : null;

  return {
    token: currentToken,
    requestEnvelope,
    responseText,
    parsed,
    mandateId,
    retried
  };
}

/**
 * One-shot call of MandateDetails. Returns raw XML + extracted result string.
 * Dates default to today → today+30y.
 */
export async function fetchMandateDetails({ token, client, mandateId, fromDate, toDate }) {
  const today = new Date();
  const future = new Date(today);
  future.setFullYear(today.getFullYear() + 30);

  const envelope = buildMandateDetailsEnvelope({
    clientCode: client.client_code,
    encryptedPassword: token,
    fromDate: fromDate || formatDateDDMMYYYY(today),
    mandateId,
    memberCode: env.memberId,
    toDate: toDate || formatDateDDMMYYYY(future)
  });

  const { text: responseText } = await soapPost(envelope);
  const raw = extractResultText(responseText, 'MandateDetailsResult');
  const parsed = parsePipeResult(raw);
  return { requestEnvelope: envelope, responseText, raw, parsed };
}

/**
 * Parse a MandateDetails SOAP response and classify it.
 * The XML contains two <Status> elements:
 *   - inner <b:Status> inside <b:MandateDetails>  →  APPROVED / REJECTED / PENDING / ...
 *   - outer <b:Status>                             →  API-level code (100)
 * We look for the first Status whose value matches a known lifecycle token.
 *
 * Returns: { status: 'success'|'failed'|'pending', terminal, mandateStatus, remarks }
 */
export function parseMandateStatus({ fullXml, raw } = {}) {
  let mandateStatus = null;
  let remarks = null;

  if (fullXml) {
    try {
      const doc = new DOMParser().parseFromString(fullXml, 'text/xml');
      const statuses = doc.getElementsByTagNameNS('*', 'Status');
      for (let i = 0; i < statuses.length; i++) {
        const val = statuses[i].textContent?.trim().toUpperCase() ?? '';
        if (['APPROVED', 'REJECTED', 'PENDING', 'INITIATED', 'EXPIRED', 'CANCELLED'].includes(val)) {
          mandateStatus = val;
          break;
        }
      }
      const remarksEl = doc.getElementsByTagNameNS('*', 'Remarks')[0];
      const remarksText = remarksEl?.textContent?.trim();
      if (remarksText) remarks = remarksText;
    } catch {
      // fall through to raw fallback below
    }
  }

  if (!mandateStatus && raw) {
    const upper = raw.toUpperCase();
    if (/\bAPPROVED\b/.test(upper)) mandateStatus = 'APPROVED';
    else if (/\bREJECTED\b/.test(upper)) mandateStatus = 'REJECTED';
  }

  if (mandateStatus === 'APPROVED') {
    return { status: 'success', terminal: true, mandateStatus, remarks };
  }
  if (mandateStatus === 'REJECTED' || mandateStatus === 'EXPIRED' || mandateStatus === 'CANCELLED') {
    return { status: 'failed', terminal: true, mandateStatus, remarks };
  }
  return { status: 'pending', terminal: false, mandateStatus, remarks };
}

/* ------------------------------------------------------------------ */
/* Param construction for UPI mandate                                 */
/* ------------------------------------------------------------------ */

function formatDateDDMMYYYY(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/**
 * Build the pipe-separated `param` string for Flag=19 UPI mandate.
 * Mandate Type hardcoded to 'U'. Amount hardcoded to 5000. End date 01/04/2031.
 */
export function buildUpiMandateParam({ client, upiId, amount = 5000, endDate = '01/04/2031' }) {
  const today = formatDateDDMMYYYY(new Date());
  return [
    client.client_code,
    amount,
    'U',
    client.bnk1_acc_no,
    client.bnk1_acc_typ,
    client.bnk1_ifsc,
    client.bnk1_micr || '',
    today,     // start_date
    endDate,   // end_date
    today,     // reg_date
    upiId
  ].join('|');
}
