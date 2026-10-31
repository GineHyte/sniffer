# Medium-risk example invoices

XRechnung CII files built from `docs/fixtures/f1.xml`. All companies, numbers and wallets are made up (seed wallets W1–W3 from docs/initial-check-spec.md 7.5).

- **Mock gateway** (`npm run customer:mock`): every file below lands in the medium band, because the invoice number was picked so the case ID's hex digit 11 mod 3 = 1 (`customer/mock.mjs` `scenarioFor`). The mock shows the same scripted criteria for every medium case.
- **Real initial check**: the reason column names the criteria each file is built to trigger. The final score also depends on the database (earlier invoices of the supplier and wallet) and on live VIES and Blockfrost answers, so a file can still land low or high there.
- Uploading the same file twice is a duplicate (same case ID; the real check answers KO-3).

| File | Invoice number | Total | Case ID (mock) | Why medium |
| --- | --- | --- | --- | --- |
| `m01-corrected-invoice.xml` | RE-2026-K0005 | 952.00 EUR | `case-bb2f0271014e1347afd86aba4a2a3325` | TypeCode 384 (corrected invoice): I-12 forces at least medium. |
| `m02-usd-currency.xml` | RE-2026-U0003 | 952.00 USD | `case-76f663101b6d88453f486c60086110fc` | Currency USD: EUR amount checks are skipped, CURRENCY_NOT_EUR forces medium. |
| `m03-urgent-new-wallet.xml` | RE-2026-W0001 | 833.00 EUR | `case-e7491ca67cf73242bbb58adbac149ac7` | Wallet W2 (first tx 27.10.2026): W-2 15, pressure words I-5 10, due 1 day after issue I-7 8; S-3 25 if Alpha already has approved invoices. |
| `m04-new-supplier-freemail.xml` | GH-2026-0001 | 800.00 EUR | `case-8064ddaa404b675c97094889fd52ac24` | Unknown supplier Gamma (S-9 5) with a gmail address (S-8 5), unused wallet W3 (W-4 10), no order (I-8 8), round total 800.00 (I-10 5); VIES valid T-4 -5. |
| `m05-buyer-mismatch.xml` | RE-2026-B0002 | 892.50 EUR | `case-330ebcdb9c35b5715b46ebc473eff4c2` | Buyer name and postcode differ from the buyer master (I-3 15), no purchase order (I-8 8). |
| `m06-just-below-threshold.xml` | RE-2026-T0006 | 4974.20 EUR | `case-55975cd9b6050b4bdb12d172e95f7b09` | Total 4974.20 EUR is within 5 % below the 5000 EUR approval threshold (I-10 5) and above the 1000 EUR limit for an untrusted wallet (I-2 20). |
| `m07-stale-final-notice.xml` | RE-2026-M0002 | 1071.00 EUR | `case-5a9fa2a6f43f1078e59ada8addefea24` | Issued 15.07.2026, more than 90 days before the check (I-6 8), due 2 days after issue (I-7 8), pressure words (I-5 10). |
