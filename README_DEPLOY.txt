MARLEY - INDEX + LOAN MEMORY BANGKALAN

Isi utama:
- index.js             : bot Marley + KPI + spreadsheet + Loan Memory
- package.json         : dependency Railway
- loan_memory.json     : database Loan Memory awal
- seed/                : backup seed database + file sumber awal

UPLOAD KE GITHUB:
Upload seluruh isi folder ini ke root repository.
Jangan upload .env / API key.

STRUKTUR:
index.js
package.json
loan_memory.json
seed/
  loan_memory.json
  Ops Report Penagihan 2026-10-02.csv
  leads_AM_Jawa_2_2026-10-02.xlsx

RAILWAY:
Disarankan Volume /app/data agar session WhatsApp, memory, dan database runtime tidak hilang saat restart/redeploy.

COMMAND LOAN:
/loan <Customer Number>
/loan <Nama Mitra>
/cari <Customer Number/Nama Mitra>

Natural:
Marley, cek loan 123456789
Marley, cek data SITI AMINAH

Sumber database awal:
1. Ops Report Penagihan 2026-10-02 = sumber utama
2. Leads AM Jawa 2 2026-10-02 = data pelengkap
Primary key = Customer Number
Area scope = Bangkalan
