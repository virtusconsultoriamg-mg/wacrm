# VIRTUS CRM enhancements

This fork adds operational layers on top of WACRM for lead-list management and AI-assisted sales.

## Contact lists and campaigns

- `contact_lists` stores independent lead lists per account.
- `contact_list_members` is many-to-many, so the same contact can belong to multiple lists.
- Contacts has dedicated list tabs; selecting a list makes it the import target.
- Imports can be done independently per list and the selected list can be used directly as a broadcast audience.
- CSV imports support comma, semicolon and tab delimiters, BOM, Portuguese header aliases (`telefone`, `nome`, `celular`, etc.) and the optional `tags` / `etiquetas` column.
- XLSX imports are supported without adding a large spreadsheet dependency; the browser reads the first worksheet using native ZIP/XML APIs.
- Duplicate phone numbers are de-duplicated inside the file and against the account, while existing contacts are still attached to the selected list.
- Admins can delete all contacts from the account through an authorization-checked database function.

## AI knowledge and media library

- PDFs, images and videos can be uploaded to the private `ai-assets` Supabase Storage bucket.
- PDFs are extracted through the configured OpenAI model and indexed into the existing AI knowledge base.
- Images and videos are presented to the automatic AI agent as approved media assets.
- When the agent emits `[SEND_MEDIA:<id>]`, the server validates the asset against the current account, creates a short-lived signed URL and sends the media through the existing WhatsApp sender.
- Image/video upload limits match practical WhatsApp sending limits (5 MB images, 16 MB videos).
- Failed PDF indexing no longer leaves the media upload transaction unusable; the original PDF remains available for review/retry.

## Database

Apply `supabase/migrations/040_contact_lists_and_ai_assets.sql` to the same Supabase project used by the CRM, then redeploy the application.

The migration creates the contact-list tables, account-scoped RLS policies, the bulk-delete RPC, and the private AI asset bucket/policies.

## Deployment

1. Back up the current database.
2. Apply all migrations through `040_contact_lists_and_ai_assets.sql`.
3. Ensure the CRM has `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and `ENCRYPTION_KEY` configured.
4. Configure the account's OpenAI key in **Settings → AI Assistant** if PDF indexing is required.
5. Install dependencies with `npm install` and run `npm run typecheck`, `npm run lint`, and `npm test` in the deployment environment.

The supplied development environment could not run the full Vitest/Next build locally because its copied `node_modules` contains Windows-only Next/SWC binaries and is missing the Linux Rolldown native binding. TypeScript and ESLint checks were run successfully against the corrected source tree.
