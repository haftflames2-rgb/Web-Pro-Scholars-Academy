SMARTTEP ACADEMY V47 — REFERRAL PROGRAMME

Included:
- Referral programme page at /referrals.html.
- Students, instructors and moderators receive a referral code when they open the referral dashboard.
- External users can apply and create a login account; their link remains inactive until Admin approves them.
- Referral links track visits and store attribution in the visitor's session for later student registration.
- Admin settings to enable/disable commissions and set percentage or fixed commission.
- Commissions are generated after Admin approves a tuition payment, only when the referral programme is enabled. Scholarship application fees and certificate payments are excluded.
- Admin can approve/reject agent applications, approve/reject commissions, and approve/reject/mark payout requests paid.
- Agent dashboards show link, clicks, referred registrations, commission totals, payout requests.

Environment variables:
- No new environment variables are required by this referral feature.
- Keep all existing Render environment variables unchanged (MongoDB, session, Cloudinary, SMTP and others already used by your project).

Before using:
1. Deploy this ZIP to the same GitHub/Render service using your existing project procedure.
2. Sign in as Admin and open /referrals.html.
3. Enable referral commissions and choose the rate. The default is disabled, 10% shown as the initial setting.
4. Test with a separate account and a test payment before announcing the programme.

Important limitations / review notes:
- The current payment submission form does not capture a numeric payment amount. The commission calculation therefore uses the total listed price of the student's enrolled courses when available. If a payment covers only some courses or is a partial payment, the amount may need a more precise billing integration before live commissions are issued.
- Referral attribution is captured through the referral URL/session and the student registration endpoint. A referral link should be opened in the same browser before registering.
- Admin approval is still required for external agents, commissions and payouts. This is not an automatic bank-payment integration.
