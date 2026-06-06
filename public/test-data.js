// ─── FOLES TEST FIXTURE ───────────────────────────────────────────────────────
// Load this page with ?test=true to skip API calls and render with this data.

const FOLES_TEST_DATA = {
  tagline: "Class A Core Multifamily Asset in Bethesda's Premier Urban Core",
  executiveSummary: "The Foles represents a compelling core investment opportunity in Bethesda, Maryland, one of the nation's most affluent submarkets with a median household income of $192,237 and 87.1% of residents holding bachelor's degrees or higher. The 325-unit, 25-story Class A asset delivered in 2022 offers stabilized cash flows at a 5.2% going-in cap rate with 92% occupancy, supported by Freddie Mac agency financing at competitive spreads currently available as low as 5.18%.",
  financingNarrative: "The proposed $67,998,846 Freddie Mac agency loan provides non-recourse financing at a conservative 65% loan-to-value with an 8.00% debt yield, well above agency minimums. The 10-year term aligns with the asset's core strategy and provides stable, long-term financing.",
  financingRateContext: "The current interest rate environment shows Freddie Mac multifamily loan rates available as low as 5.18%, reflecting moderating economic conditions. Market expectations indicate positive but weaker multifamily growth in 2025, creating a favorable window for locking in attractive long-term agency financing.",
  agencyRateSheetNarrative: "Freddie Mac continues to offer competitive spreads for stabilized, Class A multifamily assets in high-barrier markets like Bethesda, with current rates reflecting the agency's appetite for well-located, institutional-quality collateral.",
  investmentHighlights: [
    { title: "Premier Location", description: "Bethesda's $192,237 median household income — 3.5x the national average — supports premium rent levels and stable occupancy from high-quality tenants." },
    { title: "Conservative Debt Structure", description: "65% LTV and 8.00% debt yield provides substantial cushion above agency minimums, reducing credit risk in a volatile rate environment." },
    { title: "2022 Vintage Asset", description: "Modern construction eliminates near-term capital expenditure risk and positions the asset competitively against aging Bethesda inventory." },
    { title: "Supply-Constrained Market", description: "Only 54 multifamily permits issued YTD 2025 and 23,000+ units stalled in pipeline due to Montgomery County rent stabilization policy." },
    { title: "Strong Employment Base", description: "Federal government and professional services sectors anchor the local economy with 2.32% year-over-year job growth in 2024." },
    { title: "Agency Execution Advantage", description: "Non-recourse Freddie Mac financing at 65% LTV benefits from 0.44% agency delinquency rates and rates starting at 5.18%." }
  ],
  risksAndMitigants: [
    { risk: "Interest Rate Volatility", likelihood: 6, severity: 5, priority: "Moderate", trajectory: "▲", mitigant: "10-year fixed-rate agency financing locks in current spread environment; 8.00% debt yield provides cushion against rate increases at refinancing.", evidence: "Freddie Mac rates at 5.18% as of February 2025; market expects moderating conditions through 2025.", underwritingAdj: "Model exit cap rate sensitivity at 5.75%-6.00% vs. base case 5.5%." },
    { risk: "Regulatory Risk — Rent Stabilization", likelihood: 9, severity: 7, priority: "Critical", trajectory: "▶", mitigant: "Montgomery County rent stabilization enacted July 2024 applies to annual increases; 2022 construction provides operational runway.", evidence: "Montgomery County planners confirm rent stabilization has had chilling effect on multifamily production since July 2024.", underwritingAdj: "Cap Year 1+ rent growth at 3.0% vs. base case 3.5%." },
    { risk: "Occupancy Compression", likelihood: 4, severity: 5, priority: "Moderate", trajectory: "▶", mitigant: "Current 92% occupancy with rent roll showing 95.38% physical occupancy; affluent demographic base and supply constraints support lease-up.", evidence: "Rent roll indicates 310 occupied of 325 total units; T12 shows 5% vacancy and credit loss.", underwritingAdj: "Maintain 4.0% stabilized vacancy assumption." },
    { risk: "Concession Burn-Off Risk", likelihood: 5, severity: 4, priority: "Moderate", trajectory: "▲", mitigant: "T12 concessions of $412,900 represent 4.3% of GPR; Year 1 proforma assumes concession reduction as lease-up matures.", evidence: "T12 concessions of $412,900 against GPR of $9,557,870; property delivered 2022 with initial lease-up complete.", underwritingAdj: "Assume 2.0% concession rate persists through Year 2." }
  ],
  heatMapNarrative: "The risk matrix reveals one Critical-priority item in regulatory risk, driven by Montgomery County's July 2024 rent stabilization policy. Two Moderate-priority risks are mitigated by the conservative debt structure and affluent tenant base, resulting in an overall favorable risk profile for agency lending.",
  propertyOverview: "The Foles is a 25-story, 325-unit Class A multifamily tower delivered in 2022 at 8015 Old Georgetown Road in the heart of Bethesda, Maryland. The property features a contemporary unit mix of 15% studios, 40% one-bedrooms, 35% two-bedrooms, and 10% three-bedrooms with an average unit size of 791 square feet.",
  propertyCondition: "As a 2022 delivery, The Foles exhibits excellent physical condition with modern building systems, contemporary finishes, and minimal deferred maintenance requirements. The property's recent construction eliminates near-term capital expenditure risk.",
  locationOverview: "The Foles benefits from a premier location along Old Georgetown Road in Bethesda, one of the Washington DC metro area's most desirable submarkets characterized by exceptional walkability, transit access, and proximity to employment centers anchored by the National Institutes of Health and Walter Reed National Military Medical Center.",
  locationDemographics: "Bethesda commands one of the nation's most affluent demographic profiles, with a median household income of $192,237 — approximately 3.5 times the national average. The 69,397-person population exhibits exceptional educational attainment, with 87.1% holding bachelor's degrees or higher.",
  locationEmployers: "Employment in Bethesda grew 2.32% year-over-year from 2023 to 2024, expanding from 34,900 to 35,700 employees. The most common sectors are Professional, Scientific & Technical Services (9,822 people), Public Administration (5,143 people), and Educational Services (3,937 people).",
  marketOverview: "The Bethesda multifamily market exhibits strong fundamentals supported by severe supply constraints and affluent demand drivers. Montgomery County planners have documented that rent stabilization, effective July 2024, has had a chilling effect on new multifamily production, with only 54 permits issued in 2024 compared to thousands annually in prior years.",
  marketSupplyDemand: "Over 23,000 entitled but unbuilt multifamily units await construction due to economic and regulatory headwinds. This constrained pipeline supports occupancy stability and provides pricing power for well-located, stabilized assets like The Foles.",
  marketEmploymentNarrative: "Bethesda's employment base demonstrates resilience with 2.32% year-over-year job growth in 2024, driven by expansion in professional services and government-adjacent sectors providing recession-resistant demand drivers.",
  marketRentComps: "The Foles achieves average market rents of $2,465 per unit against in-place rents of $2,436, reflecting a modest 1.2% loss-to-lease. The T12 market rent of $9,557,870 represents a 2.0% increase from 2023, demonstrating steady rent growth despite rent stabilization implementation.",
  marketMacroBackdrop: "The current financing environment presents a favorable window for agency execution, with Freddie Mac multifamily rates available as low as 5.18%. The 10-year fixed-rate structure insulates the transaction from near-term rate volatility while the conservative 65% LTV provides substantial cushion for potential cap rate expansion.",
  financialSummaryNarrative: "The Foles generates T12 NOI of $5,735,604, translating to a 5.2% going-in cap rate on the $110,505,963 purchase price and an 8.00% debt yield on the proposed $67,998,846 loan. The proforma NOI of $5,856,816 reflects achievable upside through concession burn-off and operational efficiencies.",
  sponsorOverview: "Quietwood Investments brings 10 years of focused experience in the Class A multifamily sector with geographic concentration in the Washington DC, Maryland, and Virginia markets. The sponsor has established a strong track record of executing business plans and generating excess returns through disciplined acquisitions and operational excellence."
};

const FOLES_TEST_INPUTS = {
  propertyName: "The Foles",
  address: "8015 Old Georgetown Road",
  city: "Bethesda",
  state: "Maryland",
  propertyType: "Multifamily",
  units: "325",
  stories: "25",
  yearBuilt: "2022",
  askingPrice: "110505963",
  noi: "5735604",
  capRate: "5.2",
  occupancy: "92",
  loanType: "Agency — Freddie Mac",
  loanAmount: "67998846",
  loanTerm: "10",
  ltv: "65",
  debtYield: "8",
  recourse: "Non-recourse",
  guarantor: "Quietwood LLC",
  sponsorName: "Quietwood Investments",
  amenities: "2 Indoor Pools, Coffee Bar, Fitness Center with Yoga Studios, Rooftop deck with grills, Game room, Dog Wash Station",
  parking: "200",
  avgUnitSize: "791",
  avgMarketRent: "2465",
  avgInPlaceRent: "2436"
};

const FOLES_TEST_RATES = {
  treasury_10y: 4.25,
  treasury_5y: 3.95,
  sofr: 5.30,
  freddieMFRate: 5.95
};

const FOLES_TEST_T12 = {
  gpr: 9557870,
  vacancy: -477894,
  concessions: -412900,
  lossToLease: -191157,
  egi: 8475919,
  noi: 5735604,
  opex: -2740315
};

const FOLES_TEST_RENTROLL = {
  totalUnits: 325,
  occupiedUnits: 310,
  availableUnits: 15,
  occupancyRate: 95.38,
  avgUnitSize: 791,
  totalSF: 256932,
  avgMarketRent: 2465,
  avgInPlaceRent: 2436
};
