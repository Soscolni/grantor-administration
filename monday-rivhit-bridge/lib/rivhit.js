const RIVHIT_BASE = 'https://api.rivhit.co.il/online/RivhitOnlineAPI.svc';

export class RivhitError extends Error {
  constructor(message, { errorCode, clientMessage, debugMessage, httpStatus } = {}) {
    super(message);
    this.name = 'RivhitError';
    this.errorCode = errorCode;
    this.clientMessage = clientMessage;
    this.debugMessage = debugMessage;
    this.httpStatus = httpStatus;
  }
}

// Rivhit always returns HTTP 200 even for logical failures.
// The truthful success/failure signal is the `error_code` field.
export async function postRivhit(endpoint, body) {
  const apiToken = process.env.RIVHIT_API_TOKEN;
  if (!apiToken) throw new Error('RIVHIT_API_TOKEN is not set');
  if (!/^[A-Za-z][A-Za-z0-9.]+$/.test(endpoint)) {
    throw new Error(`invalid Rivhit endpoint name: ${endpoint}`);
  }
  const res = await fetch(`${RIVHIT_BASE}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ api_token: apiToken, ...body }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new RivhitError(`Rivhit ${endpoint}: non-JSON response (${res.status})`, {
      httpStatus: res.status,
      debugMessage: text.slice(0, 500),
    });
  }
  if (json.error_code !== 0) {
    throw new RivhitError(
      json.client_message || `Rivhit ${endpoint} failed (error_code=${json.error_code})`,
      {
        errorCode: json.error_code,
        clientMessage: json.client_message,
        debugMessage: json.debug_message,
        httpStatus: res.status,
      },
    );
  }
  return json.data;
}
