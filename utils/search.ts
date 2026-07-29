export const SEARCHURLS = [
  // ═══════════════════════════════════════════════════════════════════
  // BUCKET 1 — Graduate / Entry-Level Platforms (high priority)
  // ═══════════════════════════════════════════════════════════════════
  // NOTE: prosple.com and gradcracker.com are used instead of the
  // full feed feed path — Firecrawl handles discovery for these.
  "https://ng.prosple.com",
  "https://www.gradconnection.com",
  "https://www.targetjobs.co.uk/graduate-jobs",
  "https://www.milkround.com",
  "https://www.internshala.com/internships",

  // ═══════════════════════════════════════════════════════════════════
  // BUCKET 2 — Junior-Friendly Remote Boards (high priority)
  // ═══════════════════════════════════════════════════════════════════
  // NOTE: weworkremotely.com, remoteok.com, remotive.com are handled
  // by discoverFromFeeds() — excluded here to avoid double-ingest.
  "https://hiringcafe.com",
  "https://dynamitejobs.com",
  "https://remote.co",
  "https://himalayas.app",
  "https://www.levels.fyi/jobs",
  "https://startup.jobs",
  "https://www.workatastartup.com",
  "https://www.flexjobs.com",
  "https://www.inclusivejobs.co.uk",
  "https://workingnomads.com",
  "https://justremote.co",
  "https://jobspresso.co",

  // ═══════════════════════════════════════════════════════════════════
  // BUCKET 3 — African Entry-Level Boards (high priority)
  // ═══════════════════════════════════════════════════════════════════
  // Nigeria
  "https://www.jobberman.com",
  "https://www.myjobmag.com/cp/entry-level-jobs-nigeria",
  "https://www.nigeriajob.com",
  "https://www.hotnigerianjobs.com/field/269/",
  "https://www.jobzilla.ng",
  "https://www.jobgurus.com.ng",
  // Kenya
  "https://www.brightermonday.co.ke",
  "https://www.brightermonday.co.ug",
  "https://www.brightermonday.co.tz",
  "https://www.fuzu.com",
  "https://ikokazi.ke",
  // South Africa
  "https://www.shortlist.net/jobs",
  "https://www.betternship.com",
  "https://graduatelink.co.za",
  "https://spani.co.za",
  "https://freshtalent.co.za",
  "https://za.prosple.com",
  // Pan-African & multi-country
  "https://www.talentql.com",
  "https://www.andela.com",
  "https://www.gebeya.com",
  "https://remote4africa.com",
  "https://remoteafrica.io",
  "https://africarrieres.com",
  "https://zuludeskcareers.com",
  // Ethiopia
  "https://ethiojobs.net",
  // Ghana
  "https://ghanacareers.com",
  "https://ghanahire.com",
  "https://jobwebghana.com",

  // ═══════════════════════════════════════════════════════════════════
  // BUCKET 4 — Company Career Pages (mid priority)
  // Companies that hire junior engineers remotely.
  // ═══════════════════════════════════════════════════════════════════
  "https://careers.automattic.com",
  "https://careers.gitlab.com",
  "https://careers.cloudflare.com",
  "https://careers.shopify.com",
  "https://careers.canonical.com",
  "https://careers.zapier.com",
  "https://careers.docker.com",
  "https://careers.elastic.co",
  "https://careers.sourcegraph.com",
  "https://careers.grafana.com",

  // ═══════════════════════════════════════════════════════════════════
  // LOW-PRIORITY — kept for coverage but not entry-level focused
  // ═══════════════════════════════════════════════════════════════════
  // ycombinator.com/jobs — many startups need senior hires; lower crawl frequency
  "https://www.ycombinator.com/jobs",
  // cord.co — low volume; consider dropping if yield stays below threshold
  "https://cord.co",
  // landing.jobs — skews mid/senior; keep for coverage but low priority
  "https://landing.jobs",
  // arc.dev — mostly experienced contractors; keep for volume but low priority
  "https://arc.dev/en-ng/remote-jobs",
  // ng.indeed.com — aggressive anti-scraping (CAPTCHA); monitoring yield
  "https://ng.indeed.com",
  // ng.linkedin.com/jobs — login walls / IP blocking; monitoring yield
  "https://ng.linkedin.com/jobs",
  // ng.jooble.org — aggregator, decent general coverage
  "https://ng.jooble.org",
];

// Feed source config now lives in jobFeeds.ts (FEED_SOURCES, isFeedSource) —
// single source of truth so the domain-match list and fetch config can't drift.
export { FEED_SOURCES, isFeedSource } from "./jobFeeds.js";