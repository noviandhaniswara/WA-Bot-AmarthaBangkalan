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

DPD 31-90 ENGINE
- Upload file DPD 31-60 and file DPD 61-90.
- Marley combines both as DPD 31-90.
- Only Area Bangkalan is included.
- is_loan_restructured must be NO; YES is excluded from numerator and denominator.
- Target KPI DPD 31-90 = 13%.
- Marley keeps the latest 31-60 and 61-90 file per chat/group and replaces the previous source when a new file arrives.
