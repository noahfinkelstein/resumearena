/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BASE?: string;
  readonly VITE_REPO?: string;
  readonly VITE_SUBMIT_TOKEN?: string;
  readonly VITE_BUILD_ID?: string;
  readonly VITE_COMMIT?: string;
  readonly VITE_MANAGE?: string;
  readonly VITE_TOKEN_EXPIRES?: string;
  readonly VITE_CONTACT_EMAIL?: string;
  readonly VITE_MOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
