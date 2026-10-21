/// <reference types="vite/client" />

// The browser only ever sees VITE_-prefixed variables. This is the single place
// client config is read. If you find yourself wanting a value here that is not
// VITE_-prefixed, it is a server secret and does not belong in the browser.

interface ClientConfig {
  readonly apiBaseUrl: string;
}

export const config: ClientConfig = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? '',
};
