/**
 * EstateFlow AI — built-in knowledge base.
 *
 * Free, offline-first answers about the app + general real-estate /
 * property-management guidance. The chat engine (../lib/ai) scores these
 * entries against the user's question; anything unmatched gets a helpful
 * fallback. When a cloud LLM key is configured server-side, /ai-chat takes
 * over and this file becomes the system-prompt source.
 */

export type AIKnowledgeEntry = {
  id: string;
  category: "app" | "real-estate" | "howto";
  title: string;
  keywords: string[];
  answer: string;
  route?: string;
};

/**
 * Lightweight snapshot of the signed-in user's portfolio. The chat UI builds
 * this from Firestore and the server rebuilds an authoritative copy from the
 * same account, so both the offline brain and the cloud LLM can personalize.
 */
export type PortfolioContext = {
  propertyCount?: number;
  tenantCount?: number;
  monthlyIncome?: number;
  monthlyExpense?: number;
  overdueCount?: number;
  portfolioValue?: number;
};

export const KNOWLEDGE: AIKnowledgeEntry[] = [
  // ─── App: overview ──────────────────────────────────────────────
  {
    id: "what-is-estateflow",
    category: "app",
    title: "What is EstateFlow?",
    keywords: ["what is estateflow", "about the app", "what does this app do", "estateflow", "overview"],
    answer:
      "EstateFlow is a property-management app for landlords and property managers. You can: add properties with photos, assign tenants and track rent, log utilities (manually or with auto-sync), track maintenance, view Insights charts, export reports, collect rent by card via Stripe, and get due-date reminders. Open the menu (☰) on the Dashboard to reach every section.",
  },
  {
    id: "add-property",
    category: "howto",
    title: "How to add a property",
    keywords: ["add property", "new property", "create property", "add a house", "add building"],
    answer:
      "To add a property: open the menu (☰) → Add Property → fill in property name, address, type (residential/commercial), number of units, market value and monthly rent → add utilities (name, provider, amount, due day) → optionally add a photo → Save. It appears on the Dashboard and Properties screen.",
    route: "/add-property",
  },
  {
    id: "dashboard",
    category: "app",
    title: "Dashboard overview",
    keywords: ["dashboard", "portfolio value", "overview", "home screen", "summary"],
    answer:
      "The Dashboard shows your portfolio overview: total portfolio value, monthly income vs expenses, property and utility counts, Rent Due cards (with Mark Paid), your properties, and Recent Activity. Tap the bell 🔔 for upcoming rent + utility alerts and tenant-portal notifications.",
    route: "/dashboard",
  },
  {
    id: "properties-screen",
    category: "app",
    title: "Properties screen",
    keywords: ["properties", "view properties", "property list", "edit property", "delete property"],
    answer:
      "Properties lists every property you own. Tap one for details, edit its info/utilities/photo, or delete it. Use Property Breakdown for a per-property income-vs-expense view.",
    route: "/properties",
  },
  {
    id: "delete-property-tenant",
    category: "howto",
    title: "Delete a property or tenant",
    keywords: ["delete property", "remove property", "delete tenant", "remove tenant", "unassign tenant"],
    answer:
      "To delete a property: Properties → open the property → Delete (usually under a menu or trash icon) → confirm. This removes its utilities, photo, and history — export a report first if you want records. To remove a tenant: menu → Tenant Assignment → open the tenant → Delete/Unassign. Rent tracking for that tenant stops; past payments stay in your reports.",
    route: "/properties",
  },
  {
    id: "add-photo",
    category: "howto",
    title: "Add or change a property photo",
    keywords: ["property photo", "add photo", "change photo", "upload image", "property picture"],
    answer:
      "Add a photo when creating the property (Add Property form) or later by editing it: open the property → Edit → tap the photo area → choose from your library or take a new one → Save. Photos are stored in Firebase Storage and show on the Dashboard, Properties list, and property details.",
    route: "/properties",
  },
  {
    id: "tenants-assign",
    category: "howto",
    title: "Assign a tenant / track rent",
    keywords: ["tenant", "assign tenant", "add tenant", "rent", "tenant assignment", "due day", "mark paid", "rent due", "overdue"],
    answer:
      "To assign a tenant: menu → Tenant Assignment → add tenant name, pick the property, set rent amount and due day (1, 5, 10, 15, 20, 25 or last day). Rent status is automatic: Paid, Overdue, Due Soon (≤3 days), Upcoming (≤7 days), On Track. Tap Mark Paid when rent arrives — it records a payment for the current month. Tenants with an email can also pay by card through the tenant portal (Professional plan + landlord Stripe payouts connected).",
    route: "/tenants",
  },
  {
    id: "rent-collection",
    category: "howto",
    title: "Collecting rent (cash + card)",
    keywords: ["collect rent", "rent payment", "card payment", "stripe", "checkout", "tenant pay", "pay rent"],
    answer:
      "Two ways to record rent: 1) Manual — tap Mark Paid on the Dashboard or Tenants screen. 2) Card via Stripe — the tenant pays through the web portal; on success the payment is recorded automatically and you get a notification. Card collection needs the Professional plan and a finished Stripe payout setup (menu → Payouts).",
    route: "/tenants",
  },
  {
    id: "utilities-manual",
    category: "howto",
    title: "Track utilities manually",
    keywords: ["utility", "utilities", "bill", "electric", "water", "gas", "manual utility"],
    answer:
      "Every property can track Electric, Water, Gas, Oil, Sewer and Trash: amount, provider and due day. Add them in Add Property or by editing the property. Utility totals feed the Dashboard expense, Insights charts and monthly snapshots. Manual entry is always free.",
    route: "/properties",
  },
  {
    id: "utilities-autosync",
    category: "howto",
    title: "Utility auto-sync (paid)",
    keywords: ["auto-sync", "autosync", "utilityapi", "auto sync", "connect utility", "link meter", "subscription $20"],
    answer:
      "Utility auto-sync pulls your bills automatically through a secure provider connection: menu → Subscriptions → subscribe to a utility ($20/month per utility key) → Connect Utility → pick your provider and sign in → Finish linking. Each utility (Electric, Water…) needs its own subscription. Refresh a meter anytime from the property or Connect screen.",
    route: "/subscriptions",
  },
  {
    id: "sync-troubleshooting",
    category: "howto",
    title: "Sync or connection issues",
    keywords: ["sync not working", "wont sync", "not syncing", "connection error", "stuck loading", "data not updating", "meter not refreshing"],
    answer:
      "If auto-sync or data looks stuck: 1) Pull to refresh on the Dashboard or property screen. 2) Check your internet connection. 3) For utility auto-sync, confirm the subscription is active (menu → Subscriptions) and the meter shows 'Connected' — if not, go to Connect Utility and re-link, provider logins sometimes need a second try. 4) Sign out and back in to refresh your session. 5) If numbers still look wrong, check Recent Activity for the actual entries — the Dashboard summary rebuilds from those.",
  },
  {
    id: "maintenance",
    category: "howto",
    title: "Maintenance tracking",
    keywords: ["maintenance", "repair", "fix", "work order", "tenant request"],
    answer:
      "Menu → Maintenance → add a task with property, title, cost and status (pending / in-progress / done). Tenants can also submit requests from the portal — they arrive as notifications (bell 🔔) and appear here with source 'tenant'. Costs show in Recent Activity and reports.",
    route: "/maintenance",
  },
  {
    id: "insights",
    category: "app",
    title: "Insights charts",
    keywords: ["insights", "charts", "analytics", "graphs", "income vs expense", "trends"],
    answer:
      "Insights visualizes income vs expenses, per-property breakdowns and trends from your real data (rent payments, utilities, maintenance). Use it to spot which properties cost the most and how cash flow moves month to month.",
    route: "/insights",
  },
  {
    id: "export",
    category: "howto",
    title: "Export reports",
    keywords: ["export", "report", "excel", "csv", "download", "spreadsheet"],
    answer:
      "Tap Export on the Dashboard (Recent Activity), Tenants, or Insights screens to download a full report (properties, tenants, payments, maintenance) as a spreadsheet. Excel export is a Professional-plan feature — upgrade on the EstateFlow website if prompted.",
  },
  {
    id: "payouts",
    category: "howto",
    title: "Payouts / Stripe Connect",
    keywords: ["payout", "stripe connect", "onboarding", "bank account", "express", "payouts enabled"],
    answer:
      "Menu → Payouts (or Manage Subscriptions → payouts section): tap Set Up Payouts to create a Stripe Express account and connect your bank. Status shows Connected / Payouts Enabled. Money flow: tenant card → Stripe Checkout → automatic transfer to your connected account → payout to your bank.",
    route: "/payouts",
  },
  {
    id: "subscriptions-plans",
    category: "app",
    title: "Plans and subscriptions",
    keywords: ["plan", "subscription", "starter", "professional", "pricing", "upgrade", "billing", "portal billing"],
    answer:
      "Plans: Starter (basics), Professional (card rent collection, tenant portal, exports), Auto-Sync (utility auto-sync). Marketing-site checkout writes to your account by email. In-app: menu → Manage Subscriptions shows each utility key's status, billing cards, invoices and profile. Cancel anytime — access runs to the paid-through date.",
    route: "/subscriptions",
  },
  {
    id: "cancel-subscription",
    category: "howto",
    title: "Cancel or change a subscription",
    keywords: ["cancel subscription", "cancel plan", "downgrade", "stop billing", "cancel auto-sync"],
    answer:
      "Go to menu → Manage Subscriptions → find the plan or utility key you want to change → Cancel (or Change Plan). Cancelling stops future billing but keeps access until the current paid-through date — your data isn't deleted. To cancel a single utility's auto-sync, cancel just that utility key rather than the whole plan.",
    route: "/subscriptions",
  },
  {
    id: "notifications",
    category: "app",
    title: "Notifications and reminders",
    keywords: ["notification", "reminder", "bell", "alert", "due", "red dot"],
    answer:
      "The bell 🔔 shows rent due (overdue / due soon / upcoming), utility due dates, and tenant-portal events (rent paid, maintenance requests). You also get push reminders if enabled. Open the bell to mark items read; tapping a tenant notification jumps to Tenants or Maintenance.",
  },
  {
    id: "tenant-portal",
    category: "app",
    title: "Tenant portal (web)",
    keywords: ["tenant portal", "portal", "tenant login", "tenant pay online", "web portal"],
    answer:
      "The tenant portal is a website where tenants sign in, see their rent, pay by card, and submit maintenance requests. It needs the landlord on the Professional plan. Tenants link by matching email or name; card payments notify you instantly in the app.",
  },
  {
    id: "login-signup",
    category: "howto",
    title: "Sign up / log in",
    keywords: ["sign up", "log in", "login", "account", "password", "sign out"],
    answer:
      "Use Sign Up with email + password (name optional), then Log In. Data is per-account and private. Sign out from the menu. If login fails, check email/password, network, and that the Firebase project is reachable.",
    route: "/login",
  },
  {
    id: "forgot-password",
    category: "howto",
    title: "Forgot password / reset password",
    keywords: ["forgot password", "reset password", "cant log in", "cant login", "change password", "lost password"],
    answer:
      "On the login screen, tap 'Forgot password?' and enter your account email — you'll get a reset link. If you don't see the email, check spam and confirm you're using the same email you signed up with. Once reset, log in with the new password; you can also change your password anytime from account settings once logged in.",
    route: "/login",
  },
  {
    id: "data-privacy",
    category: "app",
    title: "Data privacy and security",
    keywords: ["privacy", "is my data safe", "secure", "who can see my data", "data security", "encrypted"],
    answer:
      "Your property, tenant and financial data is stored per-account in Firebase and isn't visible to other users. Only you (and anyone you explicitly share tenant-portal access with) can see it. Payments run through Stripe, which is PCI-compliant — EstateFlow never stores your card numbers directly. For full details, check the app's privacy policy on the EstateFlow website.",
  },
  {
    id: "property-breakdown",
    category: "app",
    title: "Property breakdown",
    keywords: ["breakdown", "property breakdown", "per property", "profit per property"],
    answer:
      "Property Breakdown shows income vs expenses per property so you can compare profitability side by side — useful when deciding where to raise rent or cut costs.",
    route: "/property-breakdown",
  },
  {
    id: "explore",
    category: "app",
    title: "Explore screen",
    keywords: ["explore", "discover", "search properties"],
    answer: "Explore helps you browse and discover properties and market context. Your owned portfolio lives under Properties and Dashboard.",
    route: "/explore",
  },
  {
    id: "connect-screens",
    category: "app",
    title: "Connect screens (payment / utility / authorize)",
    keywords: ["connect payment", "connect utility", "authorize", "connect-authorize"],
    answer:
      "Connect Payment starts card-checkout flows, Connect Utility links a utility meter via your provider login, and Authorize completes the secure provider handshake. If a connect screen stalls, go back and retry — provider logins sometimes need a second attempt, and subscriptions must be active first.",
  },

  // ─── Real estate: fundamentals ────────────────────────────────
  {
    id: "pm-basics",
    category: "real-estate",
    title: "Property management basics",
    keywords: ["property management", "landlord tips", "manage property", "manage rental", "beginner landlord"],
    answer:
      "Property-management essentials: 1) Screen tenants (income ~3x rent, references, background/credit where legal). 2) Use a written lease (rent, due date, late fees, maintenance duties, term). 3) Collect rent consistently + enforce late policy. 4) Maintain the property (preventive beats emergency). 5) Track income/expenses monthly — EstateFlow's Dashboard + Insights do this. 6) Keep reserves (~3–6 months expenses) for vacancies and repairs. 7) Know local landlord-tenant law before acting.",
  },
  {
    id: "screening",
    category: "real-estate",
    title: "Screening tenants",
    keywords: ["screen tenant", "background check", "credit check", "tenant screening", "good tenant", "application"],
    answer:
      "Screen every adult applicant the same way: rental application, ID, income verification (pay stubs, ~3x monthly rent), rental history/references, and credit + background + eviction checks where the law allows. Document criteria in writing and apply Fair Housing rules (no discrimination by race, color, religion, sex, disability, familial status, national origin — plus local protections). Collect only what you need and store it securely.",
  },
  {
    id: "lease",
    category: "real-estate",
    title: "Lease essentials",
    keywords: ["lease", "rental agreement", "lease term", "security deposit", "late fee", "lease clauses"],
    answer:
      "A solid lease states: parties, property, term + renewal, rent amount + due date + payment methods, late fees + grace period, security deposit terms, who handles which maintenance/utilities, occupancy + pet + smoking rules, entry notice, and termination/eviction process per state law. Have a local attorney or compliant template review it — lease law varies by state.",
  },
  {
    id: "rent-setting",
    category: "real-estate",
    title: "Setting rent",
    keywords: ["set rent", "rent price", "how much rent", "market rent", "raise rent", "rent increase"],
    answer:
      "Price rent from comparable units (beds, baths, sqft, location, amenities), then adjust for condition, vacancy cost and demand. Annual increases of ~2–5% are common where allowed — check local rent-control rules and lease terms, give proper written notice (often 30–60+ days), and keep records. Small frequent increases retain tenants better than rare big jumps.",
  },
  {
    id: "late-rent",
    category: "real-estate",
    title: "Late or missing rent",
    keywords: ["late rent", "tenant not paying", "not paying", "wont pay", "behind on rent", "missed rent", "overdue rent", "collect late"],
    answer:
      "Act early and in writing: 1) Send a polite reminder the day after due date. 2) Apply the lease's late fee after the grace period. 3) Call + offer a short written payment plan if it's a first lapse. 4) Serve a formal Pay-or-Quit notice per your state if unpaid. 5) Never shut off utilities, change locks, or remove belongings yourself — that's illegal self-help eviction in most states. In EstateFlow, overdue tenants surface on the Dashboard Rent Due card automatically.",
  },
  {
    id: "security-deposit",
    category: "real-estate",
    title: "Security deposits",
    keywords: ["security deposit", "deposit return", "deposit deductions", "move-in inspection"],
    answer:
      "Deposits are regulated by state: caps (often 1–2 months rent), separate-account/interest rules, and return deadlines (commonly 14–30 days with an itemized deduction list). Protect yourself with a signed move-in/move-out inspection + photos, and deduct only for damage beyond normal wear and tear. Never commingle deposit funds where prohibited.",
  },
  {
    id: "maintenance-strategy",
    category: "real-estate",
    title: "Maintenance strategy",
    keywords: ["maintenance plan", "preventive maintenance", "repairs", "emergency repair", "maintenance schedule"],
    answer:
      "Budget ~1–2% of property value per year for maintenance (older homes more). Schedule seasonal checks: HVAC filters/service, water heater flush, roof/gutters, smoke + CO detectors, plumbing leaks, caulking/weatherproofing. Respond to tenant requests fast (24h habitability issues, 48h urgent, ~1 week routine) — it cuts turnover. Log every job + cost in EstateFlow Maintenance so Insights reflects true expenses.",
  },
  {
    id: "cashflow-metrics",
    category: "real-estate",
    title: "Cash flow, cap rate, ROI",
    keywords: ["cap rate", "roi", "cash flow", "cash on cash", "1% rule", "50% rule", "cash-on-cash", "investment metrics"],
    answer:
      "Key formulas: Monthly cash flow = rent − (mortgage + taxes + insurance + HOA + vacancy + maintenance + management + utilities you pay). Cap rate = annual NOI ÷ property value (NOI excludes mortgage). Cash-on-cash = annual cash flow ÷ cash invested. Rules of thumb: 1% rule (rent ≈ 1% of price) and 50% rule (expenses ≈ 50% of rent) are rough screens, not decisions — always underwrite with local numbers.",
  },
  {
    id: "vacancy",
    category: "real-estate",
    title: "Reducing vacancy",
    keywords: ["vacancy", "vacant", "find tenants", "fill unit", "turnover", "reduce turnover"],
    answer:
      "Vacancy is the silent profit killer. Reduce it with: market-accurate rent, fast make-readies (target 7–14 days), great photos + listings on major portals, quick showing response, fair screening, move-in-ready condition, and renewal incentives (small discount or upgrade vs turnover cost of 1–2 months rent). Budget ~5–8% vacancy in your numbers.",
  },
  {
    id: "insurance-tax",
    category: "real-estate",
    title: "Insurance and property tax",
    keywords: ["insurance", "landlord insurance", "property tax", "taxes", "escrow", "umbrella policy"],
    answer:
      "Carry landlord (dwelling-fire/DP) insurance — not homeowners — covering building, liability and loss of rents; require tenants to carry renters insurance. Review coverage yearly. Property taxes vary by county: verify assessed value, exemptions, appeal deadlines, and escrow vs direct pay. Track both in EstateFlow as expenses/notes so your true cash flow is visible.",
  },
  {
    id: "eviction",
    category: "real-estate",
    title: "Eviction (general info)",
    keywords: ["evict", "eviction", "remove tenant", "get rid", "kick out", "notice to vacate", "pay or quit"],
    answer:
      "Eviction is strictly state/court controlled: typically notice (Pay-or-Quit / Cure-or-Quit / No-cause where allowed) → court filing → hearing → writ executed by authorities. Timelines range from weeks to months. Never use self-help (lockouts, utility shutoffs, threats). Because rules differ widely, talk to a local landlord attorney before serving notice. This is general information, not legal advice.",
  },
  {
    id: "fair-housing",
    category: "real-estate",
    title: "Fair housing",
    keywords: ["fair housing", "discrimination", "protected class", "housing discrimination", "fha"],
    answer:
      "Federal Fair Housing law forbids discriminating by race, color, national origin, religion, sex, familial status or disability in advertising, screening, terms or eviction — states/cities add more (e.g. source of income, sexual orientation). Use identical screening criteria for all applicants, document decisions, and keep ads factual ('3-bed near transit', not 'perfect for…'). When unsure, consult a housing attorney.",
  },
  {
    id: "record-keeping",
    category: "real-estate",
    title: "Record keeping and taxes",
    keywords: ["records", "bookkeeping", "tax deductions", "schedule e", "receipts", "accounting"],
    answer:
      "Keep every receipt: rent, utilities, repairs, insurance, taxes, mileage, management fees. Common deductible categories (US, verify with a CPA): mortgage interest, taxes, insurance, repairs (not improvements), management, utilities you pay, professional fees, depreciation. Reconcile monthly — EstateFlow exports give your CPA clean income/expense records.",
  },
  {
    id: "first-rental",
    category: "real-estate",
    title: "Buying your first rental",
    keywords: ["first rental", "buy rental", "investment property", "buy property", "starter investment"],
    answer:
      "First-rental checklist: 1) Financing pre-approval (investment loans differ from primary). 2) Target cash-flowing areas (jobs, schools, low vacancy). 3) Underwrite conservatively (include vacancy 5–8%, maintenance 1–2%/yr, capex reserve). 4) Inspect thoroughly (roof, foundation, electrical, plumbing, HVAC). 5) Start small (single-family or small multi). 6) Line up insurance, lease, and management workflow — EstateFlow covers tracking from day one.",
  },
  {
    id: "financing",
    category: "real-estate",
    title: "Financing a rental (mortgages)",
    keywords: ["mortgage", "financing", "loan", "interest rate", "down payment", "dscr", "heloc", "refinance", "lender"],
    answer:
      "Investment-property loans: conventional investment loans (20–25% down, slightly higher rates), DSCR loans (underwritten on the property's rent vs payment — good for scale), HELOC on your home to fund the down payment, and FHA 'house-hacking' (3.5% down while living in one unit, move out later). Rates on investor loans run ~0.5–1.5% above owner-occupied. Shop 2–3 lenders, and stress-test the deal at higher rates before committing.",
  },
  {
    id: "reits",
    category: "real-estate",
    title: "REITs (passive real estate)",
    keywords: ["reit", "reits", "passive investing", "real estate fund", "stocks real estate", "dividend"],
    answer:
      "REITs (Real Estate Investment Trusts) own income-producing property and trade like stocks — you get real-estate exposure and dividends with zero tenants or toilets. Great for small balances or passive investors; expect market volatility and no direct control. Compare against direct rentals: more effort but more control, leverage and tax benefits (depreciation). REIT dividends are taxed as ordinary income in most cases.",
  },
  {
    id: "exchange-1031",
    category: "real-estate",
    title: "1031 exchange (defer capital gains)",
    keywords: ["1031", "capital gains", "defer tax", "exchange property", "sell rental tax", "like kind"],
    answer:
      "A 1031 exchange lets you sell an investment property and reinvest the proceeds into another like-kind property, deferring capital-gains + depreciation-recapture tax. Strict deadlines apply (45 days to identify, 180 days to close) and you must use a qualified intermediary — funds can't touch your hands. Boot (leftover cash) is taxable. Ask a real-estate CPA/intermediary before listing; this is general info, not tax advice.",
  },
  {
    id: "property-manager",
    category: "real-estate",
    title: "Hiring a property manager",
    keywords: ["property manager", "management company", "management fee", "self manage", "pm company"],
    answer:
      "Property managers typically charge 8–12% of collected rent (plus ~50–100% of one month to place a tenant). They handle marketing, screening, leasing, rent collection, maintenance coordination and sometimes evictions. Worth it if you're remote, own multiple units, or value time; self-managing (what EstateFlow supports well) saves that margin but is your job. Vet managers on owner references, fee transparency, and their maintenance-markup policy.",
  },
  {
    id: "hoa",
    category: "real-estate",
    title: "HOAs and condos",
    keywords: ["hoa", "condo", "homeowners association", "assessment", "bylaws", "special assessment"],
    answer:
      "HOAs collect dues for shared upkeep and enforce rules (rental caps, approval processes, pet/tenant rules). Before buying a rental in an HOA: read covenants, rental/leasing restrictions, reserves vs special-assessment history, and dues trajectory — special assessments can wipe out cash flow for a year. Budget HOA dues as an expense (EstateFlow: add them under the property's utilities/expenses so Insights shows true margins).",
  },
  {
    id: "rent-control",
    category: "real-estate",
    title: "Rent control and increases",
    keywords: ["rent control", "rent stabilization", "increase limit", "rent cap", "notice increase"],
    answer:
      "Some states/cities cap annual increases (often 2–10% or tied to inflation) and require formal notice (commonly 30–90+ days) before raising rent; a few limit no-cause terminations. Check your local rules before any increase — illegal increases can trigger penalties. Even where allowed, moderate increases with improvements and good communication retain tenants better. Track current rent per tenant in EstateFlow's Tenant Assignment so raises are easy to model.",
  },
  {
    id: "section-8",
    category: "real-estate",
    title: "Section 8 / housing vouchers",
    keywords: ["section 8", "voucher", "housing choice", "hud", "subsidized tenant", "public housing"],
    answer:
      "Section 8 (Housing Choice Voucher) tenants pay ~30% of income toward rent and the housing authority pays the rest directly. Pros: reliable government portion, low vacancy in strong demand areas. Cons: inspection process (HUD's housing-quality standards), unit-rent caps (fair-market rent), annual recertifications, and some extra paperwork. Approval laws vary — some states ban refusing voucher tenants. Keep income records clean; EstateFlow's exports help with recertification.",
  },
  {
    id: "depreciation",
    category: "real-estate",
    title: "Depreciation basics",
    keywords: ["depreciation", "basis", "27.5 years", "recapture", "cost seg", "depreciate building"],
    answer:
      "Residential rentals depreciate the building (not land) over 27.5 years — a non-cash deduction that often makes profitable properties show a paper loss. Cost-segregation studies can accelerate parts of it. When you sell, depreciation is 'recaptured' and taxed (currently up to 25% federally) unless deferred via a 1031 exchange. Improvements (new roof) depreciate separately; repairs are deducted immediately. Confirm specifics with a CPA — general info only.",
  },
  {
    id: "appraisal",
    category: "real-estate",
    title: "Appraisals and property value",
    keywords: ["appraisal", "appraised value", "property valuation", "worth", "comps", "comparable", "market value", "how much is my property worth"],
    answer:
      "Appraisers value property primarily from comparables (recent nearby sales) and, for rentals, sometimes the income approach (NOI ÷ cap rate). You can contest a low appraisal with better comps, document condition upgrades, or appeal your tax assessment separately. EstateFlow's market-value field feeds your Dashboard portfolio value — update it annually or after major renovations so Insights reflects reality.",
  },
  {
    id: "move-out",
    category: "real-estate",
    title: "Move-out and turnovers",
    keywords: ["move out", "tenant leaving", "turnover", "make ready", "re-lease", "end of lease", "walkthrough"],
    answer:
      "Smooth turnover playbook: 1) Get written notice and confirm the move-out date. 2) Schedule a pre-move-out walkthrough with the tenant. 3) Itemize deposit deductions with photos (normal wear ≠ damage). 4) Return the deposit within your state's deadline. 5) Make-ready: clean, paint touch-up, rekey, service HVAC, fix punch-list items. 6) Market the unit immediately (photos from day one). Target 7–14 days vacant — every month empty costs ~8% of annual rent.",
  },
  {
    id: "llc-structure",
    category: "real-estate",
    title: "LLCs and liability",
    keywords: ["llc", "llc rental", "liability", "umbrella", "asset protection", "business structure", "sole proprietor"],
    answer:
      "Common setups: sole proprietor (simplest, personal liability), LLC per property or portfolio (separates business liability, needs its own bank account and operating agreement), plus an umbrella insurance policy ($1–2M) as cheap extra protection. Transferring a titled property into an LLC can trigger due-on-sale or transfer-tax issues — ask a real-estate attorney first. Keep good books regardless; EstateFlow exports give your attorney/CPA clean records.",
  },
  {
    id: "short-term-rental",
    category: "real-estate",
    title: "Short-term vs long-term rentals",
    keywords: ["airbnb", "short term rental", "str", "vacation rental", "midterm rental", "furnished rental"],
    answer:
      "Short-term (Airbnb/VRBO) can gross 2–3x long-term rent in tourist/business areas but needs furnishing, frequent cleaning, dynamic pricing, permits/HOA approval, and absorbs vacancy + platform fees. Long-term is steadier with less work. Middle path: mid-term furnished rentals (30+ days) for traveling nurses/relocators. If you own both, track each property separately in EstateFlow so Insights shows which model actually wins in your market.",
  },
  {
    id: "tenant-retention",
    category: "real-estate",
    title: "Keeping good tenants",
    keywords: ["tenant retention", "renew lease", "good tenant leave", "renewal", "keep tenant happy", "retention"],
    answer:
      "Every good tenant who stays saves you turnover costs (make-ready + vacancy ≈ 1–2 months' rent). Retention wins: respond to repairs fast, small renewal upgrades or modest increases instead of market-max jumps, easy rent payment (EstateFlow's card portal), proper notice and respect of privacy, and a short renewal survey ('anything we can fix before you re-sign?'). Screen well up front — retention starts with tenants who fit the property.",
  },
  {
    id: "winter-seasonal",
    category: "real-estate",
    title: "Seasonal maintenance checklist",
    keywords: ["seasonal", "winterize", "fall checklist", "spring checklist", "hvac filter", "gutter cleaning", "preventive checklist"],
    answer:
      "Seasonal preventive checklist: Fall — gutter cleaning, roof/flashings, seal exterior gaps, furnace service, disconnect hoses, insulate exposed pipes. Winter — watch for ice dams, test smoke/CO detectors, check attic ventilation. Spring — A/C service, exterior paint/caulk, irrigation, foundation drainage. Summer — deck/fence, water-heater flush, tree trimming. Filter changes every 1–3 months. Log each job in EstateFlow Maintenance so costs and history stay visible.",
  },
  {
    id: "landlord-insurance-claims",
    category: "real-estate",
    title: "Insurance claims and damage",
    keywords: ["insurance claim", "water damage", "fire damage", "storm damage", "deductible claim", "loss of rent"],
    answer:
      "After damage: 1) Mitigate further loss immediately (shut water off, board up) — keep receipts. 2) Photograph everything before cleanup. 3) File promptly; adjusters pay on documented loss. 4) Loss-of-rents coverage can reimburse missed rent during repairs if your policy includes it. 5) Raise deductibles rather than filing small claims (frequent claims raise premiums or get you dropped). Track repair costs in EstateFlow Maintenance and keep the claim paperwork with your records.",
  },
];

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9$%./\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * EstateFlow AI search engine.
 *
 * Improvements over the original:
 * - intent detection
 * - phrase + token + fuzzy matching
 * - synonym expansion
 * - negative/irrelevant-word filtering
 * - category-aware ranking
 * - confidence scoring
 * - duplicate-topic suppression
 * - better fallback/clarifying suggestions
 * - lightweight numeric/property calculations
 * - prompt context generation for the optional cloud LLM
 */

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "can", "do", "does", "for",
  "from", "how", "i", "if", "in", "is", "it", "me", "my", "of", "on", "or",
  "should", "the", "this", "to", "what", "when", "where", "which", "who", "with",
  "would", "you", "your", "about", "please", "tell", "could", "there", "than",
]);

const SYNONYMS: Record<string, string[]> = {
  tenant: ["renter", "lessee", "occupant", "resident"],
  renter: ["tenant", "lessee", "resident"],
  rent: ["lease payment", "rental income", "monthly payment", "rent payment"],
  rental: ["rent", "lease", "property"],
  utilities: ["utility", "bills", "electricity", "water bill", "gas bill", "services"],
  utility: ["utilities", "bill", "electric", "water", "gas", "oil", "sewer", "trash"],
  bill: ["bills", "invoice", "utility", "utilities", "expense"],
  maintenance: ["repair", "fix", "upkeep", "service request", "work order"],
  property: ["house", "home", "unit", "apartment", "building", "rental"],
  profit: ["income", "revenue", "cash flow", "earnings", "return"],
  expense: ["cost", "spending", "outgoings", "expenses"],
  landlord: ["owner", "property manager", "lessor"],
  manager: ["landlord", "property manager"],
  buy: ["purchase", "acquire", "invest"],
  sell: ["sale", "offload", "exit"],
  deposit: ["security deposit", "down payment"],
  evict: ["eviction", "remove tenant", "kick out"],
  insurance: ["coverage", "policy", "premium"],
  tax: ["taxes", "irs", "deduction", "deductions"],
  mortgage: ["loan", "financing", "finance", "lender"],
  increase: ["raise", "hike", "escalate"],
  vacancy: ["empty", "unoccupied", "vacant"],
  screen: ["screening", "vet", "vetting", "background", "check"],
  app: ["estateflow", "application", "software", "tool", "platform"],
  question: ["help", "how", "what", "explain", "guide"],
  password: ["login", "credentials", "signin", "sign in"],
  cancel: ["unsubscribe", "downgrade", "stop"],
  photo: ["picture", "image"],
  privacy: ["secure", "security", "safe"],
  delete: ["remove", "erase"],
  payout: ["payouts", "stripe connect", "bank transfer"],
  sync: ["autosync", "auto sync", "connection", "connect", "refresh"],
};

const INTENT_RULES: Array<{
  intent: AIIntent;
  patterns: string[];
  category?: AIKnowledgeEntry["category"];
}> = [
  { intent: "app_help", patterns: ["estateflow", "dashboard", "app", "screen", "menu", "feature", "where do i"] },
  { intent: "add_property", patterns: ["add property", "new property", "create property", "add house", "add building"] },
  { intent: "tenant_rent", patterns: ["tenant", "renter", "rent", "lease payment", "rent due", "rent paid", "overdue"] },
  { intent: "utilities", patterns: ["utility", "utilities", "electric", "water", "gas", "oil", "sewer", "trash", "bill"] },
  { intent: "maintenance", patterns: ["maintenance", "repair", "fix", "work order", "service request"] },
  { intent: "subscriptions", patterns: ["subscription", "plan", "pricing", "billing", "upgrade", "cancel"] },
  { intent: "payments", patterns: ["stripe", "card payment", "collect rent", "checkout", "payout"] },
  { intent: "investment", patterns: ["cap rate", "roi", "cash flow", "cash on cash", "investment", "property value", "worth"] , category: "real-estate"},
  { intent: "legal_housing", patterns: ["eviction", "evict", "fair housing", "discrimination", "rent control", "section 8", "security deposit", "lease law"] , category: "real-estate"},
  { intent: "taxes", patterns: ["tax", "irs", "depreciation", "1031", "deduction", "schedule e"] , category: "real-estate"},
  { intent: "troubleshooting", patterns: ["not working", "wont work", "doesnt work", "stuck", "error", "not syncing", "not loading", "missing"] },
];

export type AIIntent =
  | "app_help"
  | "add_property"
  | "tenant_rent"
  | "utilities"
  | "maintenance"
  | "subscriptions"
  | "payments"
  | "investment"
  | "legal_housing"
  | "taxes"
  | "troubleshooting"
  | "general";

export type AIQueryAnalysis = {
  query: string;
  normalized: string;
  intent: AIIntent;
  confidence: number;
  results: AIKnowledgeEntry[];
  suggestions: string[];
  needsClarification: boolean;
};

function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 5 && w.endsWith("ers")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("es")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

function contentTokens(q: string): string[] {
  return normalize(q)
    .split(" ")
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .map(stem);
}

function expandQuery(q: string): string {
  const words = normalize(q).split(" ");
  const extra: string[] = [];
  for (const w of words) {
    const key = stem(w);
    for (const [canonical, synonyms] of Object.entries(SYNONYMS)) {
      if (stem(canonical) === key) extra.push(...synonyms);
      else if (synonyms.some((s) => stem(normalize(s)) === key)) extra.push(canonical);
    }
  }
  return Array.from(new Set([...words, ...extra])).join(" ");
}

function isOrderedSubsequence(parts: string[], words: string[]): boolean {
  const stemmed = words.map(stem);
  let i = 0;
  for (const part of parts) {
    const target = stem(part);
    let found = false;
    while (i < stemmed.length) {
      if (stemmed[i] === target) {
        found = true;
        i++;
        break;
      }
      i++;
    }
    if (!found) return false;
  }
  return true;
}

function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      curr.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  return prev[b.length];
}

function fuzzyMatch(word: string, target: string): boolean {
  if (word === target) return true;
  if (word.length < 4 || target.length < 4) return false;
  const max = Math.min(word.length <= 7 ? 1 : 2, target.length <= 7 ? 1 : 2);
  return editDistance(word, target, max) <= max;
}

function detectIntent(query: string): { intent: AIIntent; confidence: number } {
  const raw = normalize(query);
  const tokens = contentTokens(raw);
  let best: { intent: AIIntent; score: number } = { intent: "general", score: 0 };

  for (const rule of INTENT_RULES) {
    let score = 0;
    for (const pattern of rule.patterns) {
      const p = normalize(pattern);
      if (raw === p) score += 12;
      else if (raw.includes(p)) score += p.includes(" ") ? 8 : 4;
      else if (isOrderedSubsequence(p.split(" "), raw.split(" "))) score += p.includes(" ") ? 5 : 2;
    }
    if (score > best.score) best = { intent: rule.intent, score };
  }

  const confidence = best.score === 0 ? 0 : Math.min(1, best.score / 12);
  return { intent: best.intent, confidence };
}

function scoreEntry(query: string, entry: AIKnowledgeEntry, intent: AIIntent = "general"): number {
  const raw = normalize(query);
  if (!raw) return 0;

  const expanded = expandQuery(raw);
  const queryTokens = contentTokens(expanded);
  const rawTokens = contentTokens(raw);
  const title = normalize(entry.title);
  const answer = normalize(entry.answer);
  const keywordText = normalize(entry.keywords.join(" "));
  let score = 0;

  // Strong phrase matching.
  for (const keyword of entry.keywords) {
    const k = normalize(keyword);
    if (!k) continue;
    if (raw === k) score += 30;
    else if (raw.includes(k)) score += 16 + Math.min(8, k.split(" ").length * 2);
    else if (k.includes(raw) && raw.length >= 5) score += 7;
    else if (k.split(" ").length > 1 && isOrderedSubsequence(k.split(" "), raw.split(" "))) score += 11;
  }

  // Token relevance.
  const keywordTokens = new Set(contentTokens(keywordText));
  const titleTokens = new Set(contentTokens(title));
  let covered = 0;
  for (const token of rawTokens) {
    if (keywordTokens.has(token)) {
      score += 5;
      covered++;
    } else if (titleTokens.has(token)) {
      score += 7;
      covered++;
    } else if (queryTokens.some((q) => fuzzyMatch(q, token))) {
      score += 1.5;
    }
  }

  // Expanded synonyms improve recall, but don't overpower exact matches.
  for (const token of queryTokens) {
    if (keywordTokens.has(token)) score += 1.5;
    if (answer.includes(token)) score += 0.5;
  }

  if (rawTokens.length) score += (covered / rawTokens.length) * 10;

  // Intent/category alignment.
  const categoryByIntent: Partial<Record<AIIntent, AIKnowledgeEntry["category"]>> = {
    app_help: "app",
    add_property: "howto",
    tenant_rent: "howto",
    utilities: "howto",
    maintenance: "howto",
    subscriptions: "app",
    payments: "howto",
    investment: "real-estate",
    legal_housing: "real-estate",
    taxes: "real-estate",
    troubleshooting: "howto",
  };
  if (categoryByIntent[intent] === entry.category) score += 4;

  return score;
}

export function searchKnowledge(query: string, topN = 3): AIKnowledgeEntry[] {
  const { intent } = detectIntent(query);
  const ranked = KNOWLEDGE
    .map((entry) => ({ entry, score: scoreEntry(query, entry, intent) }))
    .filter((item) => item.score >= 5)
    .sort((a, b) => b.score - a.score);

  // Avoid returning several nearly identical topics.
  const selected: AIKnowledgeEntry[] = [];
  const usedCategories = new Set<string>();
  for (const item of ranked) {
    const categoryKey = `${item.entry.category}:${item.entry.title.split(" ")[0]}`;
    if (selected.length >= topN) break;
    if (usedCategories.has(categoryKey) && item.score < 12) continue;
    usedCategories.add(categoryKey);
    selected.push(item.entry);
  }
  return selected;
}

export function suggestTopics(query: string, topN = 4): { title: string }[] {
  return KNOWLEDGE
    .map((entry) => ({ entry, score: scoreEntry(query, entry, detectIntent(query).intent) }))
    .filter((x) => x.score >= 5)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map((x) => ({ title: x.entry.title }));
}

/** Analyze a question before deciding how EstateFlow AI should respond. */
export function analyzeQuery(query: string): AIQueryAnalysis {
  const normalized = normalize(query);
  const { intent, confidence } = detectIntent(normalized);
  const results = searchKnowledge(normalized, 3);
  const suggestions = suggestTopics(normalized, 4).map((x) => x.title);

  const shortOrVague = contentTokens(normalized).length < 2;
  const needsClarification = normalized.length === 0 || (confidence < 0.25 && results.length === 0) || shortOrVague;

  return {
    query,
    normalized,
    intent,
    confidence,
    results,
    suggestions,
    needsClarification,
  };
}

/**
 * Simple calculations the local assistant can safely perform without an LLM.
 * Returns null when the question does not contain enough numbers.
 */
export type CalculationResultType =
  | "monthly_cash_flow"
  | "annual_rent"
  | "annual_income"
  | "cap_rate"
  | "cash_on_cash"
  | "rent_to_value"
  | "one_percent"
  | "screening_income"
  | "dscr"
  | "monthly_mortgage"
  | "portfolio_cash_flow"
  | "portfolio_income"
  | "portfolio_expense"
  | "portfolio_value";

export type CalculationResult = {
  type: CalculationResultType;
  value: number;
  explanation: string;
};

type NumToken = { value: number; percent: boolean };

function numberTokens(text: string): NumToken[] {
  const out: NumToken[] = [];
  const re = /\$?(\d[\d,]*(?:\.\d+)?)\s*(%)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({ value: Number(m[1].replace(/,/g, "")), percent: !!m[2] });
  }
  return out;
}

/** Numbers that appear AFTER the first occurrence of a label (e.g. "noi"). */
function numsAfter(text: string, labelRe: RegExp): number[] {
  const idx = text.search(labelRe);
  if (idx < 0) return [];
  return numberTokens(text.slice(idx)).map((t) => t.value);
}

export function calculateFromQuestion(query: string): CalculationResult | null {
  const q = normalize(query);
  const tokens = numberTokens(q);
  const nums = tokens.map((t) => t.value);
  if (!nums.length) return null;
  const includes = (re: RegExp) => re.test(q);
  const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
  const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

  // Cap rate: annual NOI ÷ property value. Prefer numbers next to their labels.
  if (includes(/cap\s?rate/)) {
    const noi = (numsAfter(q, /noi|net operating income/)[0] ?? nums[0]) || 0;
    const value = (numsAfter(q, /property value|worth|price|bought for|purchase/)[0] ?? nums[1]) || 0;
    if (noi > 0 && value > 0) {
      return { type: "cap_rate", value: (noi / value) * 100, explanation: `Cap rate = annual NOI ÷ property value = ${money(noi)} ÷ ${money(value)} = ${pct(noi / value)} per year.` };
    }
  }

  // Cash-on-cash: annual cash flow ÷ cash invested.
  if (includes(/cash[\s-]?on[\s-]?cash/) && nums.length >= 2 && nums[1] !== 0) {
    const cashFlow = nums[0];
    const invested = nums[1];
    return { type: "cash_on_cash", value: (cashFlow / invested) * 100, explanation: `Cash-on-cash return = annual cash flow ÷ cash invested = ${money(cashFlow)} ÷ ${money(invested)} = ${pct(cashFlow / invested)}.` };
  }

  // Monthly mortgage payment (principal + interest) from principal, annual rate
  // %, and term in years. Term defaults to 30 years when only two numbers given.
  if (includes(/mortgage|loan payment|loan of|amorti[sz]|pmt\b/)) {
    const rateTok = tokens.find((t) => t.percent);
    const nonPercent = tokens.filter((t) => !t.percent);
    if (nonPercent.length >= 1 && rateTok && rateTok.value > 0) {
      const principal = Math.max(...nonPercent.map((t) => t.value));
      const years = nonPercent.length >= 2 ? Math.min(...nonPercent.map((t) => t.value)) : 30;
      if (principal > 0 && years > 0) {
        const r = rateTok.value / 100 / 12;
        const n = years * 12;
        const payment = (principal * r) / (1 - Math.pow(1 + r, -n));
        return {
          type: "monthly_mortgage",
          value: payment,
          explanation: `Monthly mortgage payment (P&I) for ${money(principal)} at ${rateTok.value}% APR over ${years} years ≈ ${money(payment)}/mo (excludes taxes & insurance).`,
        };
      }
    }
  }

  // Tenant screening: income ÷ rent multiple (~3x is the common guideline).
  if (includes(/(screen|qualif|apply|afford).*rent|rent.*(screen|qualif|income)/) && nums.length >= 2) {
    const income = Math.max(...nums);
    const rent = Math.min(...nums);
    if (rent > 0) {
      return { type: "screening_income", value: income / rent, explanation: `Income ÷ rent = ${money(income)} ÷ ${money(rent)} = ${(income / rent).toFixed(2)}x — landlords typically want income ≈ 3x rent.` };
    }
  }

  // DSCR: annual NOI ÷ annual debt service.
  if (includes(/dscr|debt service|debt[ -]coverage/) && nums.length >= 2 && nums[1] !== 0) {
    const noi = nums[0];
    const debt = nums[1];
    return { type: "dscr", value: noi / debt, explanation: `DSCR = annual NOI ÷ annual debt service = ${money(noi)} ÷ ${money(debt)} = ${(noi / debt).toFixed(2)}x (lenders usually want ≥ 1.2–1.25).` };
  }

  // 1% rule: monthly rent ≈ 1% of purchase price. The literal "1%" in the
  // question names the rule, so only compare non-percentage dollar figures.
  if (includes(/1\s?%?\s?rule|one percent rule/)) {
    const plainNums = tokens.filter((t) => !t.percent).map((t) => t.value);
    if (plainNums.length >= 2) {
      const rent = Math.min(...plainNums);
      const price = Math.max(...plainNums);
      if (price > 0) {
        return { type: "one_percent", value: (rent / price) * 100, explanation: `Rent ÷ price = ${money(rent)} ÷ ${money(price)} = ${((rent / price) * 100).toFixed(2)}% monthly (the 1% rule targets ≈ 1%).` };
      }
    }
  }

  // Cash flow from two numbers.
  if (includes(/cash flow|cashflow/) && nums.length >= 2) {
    const income = Math.max(...nums);
    const expenses = Math.min(...nums);
    return { type: "monthly_cash_flow", value: income - expenses, explanation: `Cash flow = income − expenses = ${money(income)} − ${money(expenses)} = ${money(income - expenses)}.` };
  }

  // Annual income / annual rent from a single monthly number (×12).
  if (includes(/annual rent|yearly rent|annual income|yearly income/) && nums.length >= 1) {
    return { type: "annual_rent", value: nums[0] * 12, explanation: `Annual = monthly × 12 = ${money(nums[0])} × 12 = ${money(nums[0] * 12)}.` };
  }

  // Gross yield / rent-to-value: annual rent ÷ property value.
  if (includes(/rent to value|rent[\/\s]value|rent to price|gross yield/) && nums.length >= 2 && nums[1] > 0) {
    const rent = nums[0];
    const value = nums[1];
    if (value > 0 && rent > 0) {
      return { type: "rent_to_value", value: (rent * 12) / value, explanation: `Gross yield = annual rent ÷ property value = (${money(rent)} × 12) ÷ ${money(value)} = ${pct((rent * 12) / value)}.` };
    }
  }

  return null;
}

/**
 * Calculator that also understands the user's own portfolio. Runs the plain
 * formula calculator first; when the question refers to the user's numbers
 * ("my monthly cash flow" with no figures typed) it answers from ctx instead.
 */
export function calculateWithContext(query: string, ctx?: PortfolioContext): CalculationResult | null {
  const base = calculateFromQuestion(query);
  if (base) return base;
  const q = normalize(query);
  const includes = (re: RegExp) => re.test(q);
  const has = (n?: number) => typeof n === "number" && n > 0;
  const inc = has(ctx?.monthlyIncome);
  const exp = has(ctx?.monthlyExpense);
  const val = has(ctx?.portfolioValue);
  const $ = (n: number) => `$${Math.round(n).toLocaleString()}`;

  const asksIncome = includes(/(my |our )?(total )?monthly income|my income|how much (do i|am i|do we) (make|earn|get|bring)|(what's|what is) my income/);
  const asksExpense = includes(/(my |our )?monthly (expense|expenses|spending)|how much do i spend|what are my (monthly )?(expenses|costs|bills)/);
  const asksCashFlow = includes(/cash flow|profit|left over|pocket|net (income|cash)|how much (do i|am i) (keep|have left)/);
  const asksValue = includes(/portfolio worth|portfolio value|my (properties|portfolio|buildings) worth|total value of/);

  if (asksValue && val) {
    return { type: "portfolio_value", value: ctx!.portfolioValue!, explanation: `Based on your tracked data, your property portfolio is worth about ${$(ctx!.portfolioValue!)} in total market value.` };
  }
  if (asksIncome && inc) {
    return { type: "portfolio_income", value: ctx!.monthlyIncome!, explanation: `Based on your tracked data, your monthly income is about ${$(ctx!.monthlyIncome!)}.` };
  }
  if (asksExpense && exp) {
    return { type: "portfolio_expense", value: ctx!.monthlyExpense!, explanation: `Based on your tracked data, your monthly expenses are about ${$(ctx!.monthlyExpense!)}.` };
  }
  if (asksCashFlow && inc && exp) {
    return { type: "portfolio_cash_flow", value: ctx!.monthlyIncome! - ctx!.monthlyExpense!, explanation: `Based on your tracked numbers: cash flow = income − expenses = ${$(ctx!.monthlyIncome!)} − ${$(ctx!.monthlyExpense!)} ≈ ${$(ctx!.monthlyIncome! - ctx!.monthlyExpense!)}/month.` };
  }
  return null;
}

/** One-line human summary of a portfolio snapshot (used in prompts + answers). */
export function summarizePortfolio(ctx?: PortfolioContext): string {
  if (!ctx) return "";
  const bits: string[] = [];
  if (typeof ctx.propertyCount === "number" && ctx.propertyCount > 0) bits.push(`${ctx.propertyCount} ${ctx.propertyCount === 1 ? "property" : "properties"}`);
  if (typeof ctx.tenantCount === "number" && ctx.tenantCount > 0) bits.push(`${ctx.tenantCount} tenant${ctx.tenantCount === 1 ? "" : "s"}`);
  if (typeof ctx.monthlyIncome === "number" && ctx.monthlyIncome > 0) bits.push(`$${Math.round(ctx.monthlyIncome).toLocaleString()}/mo income`);
  if (typeof ctx.monthlyExpense === "number" && ctx.monthlyExpense > 0) bits.push(`$${Math.round(ctx.monthlyExpense).toLocaleString()}/mo expenses`);
  if (typeof ctx.overdueCount === "number" && ctx.overdueCount > 0) bits.push(`${ctx.overdueCount} overdue rent${ctx.overdueCount === 1 ? "" : "s"}`);
  if (typeof ctx.portfolioValue === "number" && ctx.portfolioValue > 0) bits.push(`$${Math.round(ctx.portfolioValue).toLocaleString()} portfolio value`);
  return bits.length ? `Portfolio snapshot: ${bits.join(", ")}.` : "";
}

/** Nicely formatted value of a finished calculation (money / multiple / %). */
export function formatCalculation(r: CalculationResult): string {
  const moneyTypes: CalculationResultType[] = [
    "monthly_cash_flow",
    "annual_rent",
    "annual_income",
    "monthly_mortgage",
    "portfolio_cash_flow",
    "portfolio_income",
    "portfolio_expense",
    "portfolio_value",
  ];
  if (moneyTypes.includes(r.type)) return `$${Math.round(r.value).toLocaleString()}`;
  if (r.type === "screening_income" || r.type === "dscr") return `${r.value.toFixed(2)}x`;
  return `${(r.value as number).toFixed(2)}%`;
}

/**
 * Build a compact context string for /ai-chat.
 * The cloud model can use this instead of receiving the entire knowledge base.
 */
export function buildAIContext(query: string, maxEntries = 2, ctx?: PortfolioContext): string {
  const analysis = analyzeQuery(query);
  const calculation = calculateWithContext(query, ctx);
  const knowledge = analysis.results.slice(0, maxEntries);

  const sections = [
    `Intent: ${analysis.intent}`,
    `Confidence: ${Math.round(analysis.confidence * 100)}%`,
    knowledge.length
      ? `Relevant EstateFlow knowledge:\n${knowledge.map((e) => `- ${e.title}: ${e.answer}`).join("\n")}`
      : "No exact knowledge-base answer found.",
  ];

  if (calculation) sections.push(`Calculation: ${calculation.explanation} Result: ${formatCalculation(calculation)}.`);
  if (analysis.suggestions.length) sections.push(`Related topics: ${analysis.suggestions.join(", ")}.`);
  const portfolioLine = summarizePortfolio(ctx);
  if (portfolioLine) sections.push(portfolioLine);
  return sections.join("\n\n");
}

/** Response guidance for the optional LLM endpoint. */
export const AI_SYSTEM_GUIDANCE = `
You are EstateFlow AI, a helpful property-management assistant.

Rules:
1. Answer the user's actual question first. Do not dump unrelated knowledge-base entries.
2. Prefer EstateFlow's documented features when the question is about the app.
3. When giving property-management advice, be practical and concise.
4. Never invent a feature, screen, price, integration, or user-data value that is not provided in context.
5. If the answer depends on the user's portfolio data, ask for or use the supplied data instead of guessing.
6. For legal, tax, insurance, or financial decisions, clearly say the information is general and can depend on local rules or the user's situation.
7. If the question is ambiguous, ask one focused clarification question rather than guessing.
8. Use short paragraphs and bullets when they make the answer easier to scan.
9. If a calculation is supplied by the local calculator, preserve the calculation and result.
10. Never claim that an action was completed unless the application actually completed it.
`;

export const QUICK_QUESTIONS = [
  "How do I add a property?",
  "How do I assign a tenant?",
  "How do I track maintenance?",
  "How do I track utilities?",
  "How do rent payments work?",
  "What plans do you offer?",
  "How is cap rate calculated?",
  "What should a lease include?",
  "How do I screen tenants?",
  "How much should rent be?",
  "What is a 1031 exchange?",
  "Should I use an LLC?",
  "How do I raise rent safely?",
  "How do payouts work?",
];
