/* ============================================================
   Nirman Ledger — cloud sync configuration
   ------------------------------------------------------------
   Paste the two values from your free Supabase project
   (Project Settings -> API), then upload this file next to
   index.html. Until real values are filled in, sync simply
   stays off and the app works as before.

   Guide: see README-setup-guide in the same folder.
   ============================================================ */
window.NL_CLOUD_CONFIG = {
  provider: 'supabase',
  url: 'https://lqszfntmobevbrnpquxy.supabase.co',
  anon_key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxxc3pmbnRtb2JldmJybnBxdXh5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA4NDA0OTksImV4cCI6MjEwNjQxNjQ5OX0._AhCloOtb0BJ94WUJL66c70QRkhQr4EL3vsXDBcc3qk',
  table: 'nirman_sync'
};
