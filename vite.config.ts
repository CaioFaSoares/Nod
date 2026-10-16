import { defineConfig } from 'vite';

// Single page: everything to manage and use Bond lives in the main window (docs/arquitetura.md §5).
// BOND_DEV_PORT lets the smoke run its own dev server next to a developer's `bun run app:dev`.
export default defineConfig({
  server: { port: Number(process.env.BOND_DEV_PORT ?? 5173) },
});
