// Bundlers (Vite, and others following its convention) replace `import.meta.env` statically.
interface ImportMeta {
  readonly env?: { readonly DEV?: boolean };
}
