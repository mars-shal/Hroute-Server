export const SEARCHURLS = [
  // Major tech remote boards
  // NOTE: weworkremotely.com, remoteok.com, remotive.com are intentionally
  // excluded here — they're handled by discoverFromFeeds() instead, see
  // isFeedSource() below. Keeping them in this list would double-ingest them
  // (once via feed, once via Firecrawl).
  "https://remote.co",
  "https://himalayas.app",
  // Tech startup & senior
  "https://wellfound.com",
  "https://www.ycombinator.com/jobs",
  "https://arc.dev/en-ng/remote-jobs",
  "https://cord.co", // verify this isn't meant to be cord.com — confirm before next crawl
  "https://landing.jobs",
  // Tech aggregators
  "https://hiringcafe.com",
  "https://dynamitejobs.com",
  "https://workingnomads.com",
  "https://dailyremote.com",
  "https://justremote.co",
  "https://jobspresso.co",
  // Africa-focused
  "https://jobberman.com", // was listed twice (also as jobberman.com/jobs) — consolidated to one seed
  "https://remote4africa.com",
  "https://remoteafrica.io",
  "https://www.myjobmag.com/jobs-by-type/remote",
  "https://www.hotnigerianjobs.com/field/269/",
  "https://www.betternship.com",
  "https://www.talentql.com",
  "https://www.andela.com",
  "https://www.gebeya.com",
  // Nigeria-focused / Nigeria-friendly additions
  // NOTE: ng.indeed.com and ng.linkedin.com/jobs are known aggressive anti-scraping
  // targets (CAPTCHA / login walls / IP blocking). Left in for now but worth
  // monitoring their success rate separately — they're likely to burn Firecrawl
  // retries for low yield. Consider dropping if the numbers confirm that.
  "https://ng.indeed.com",
  "https://ng.linkedin.com/jobs",
  "https://www.nigeriajob.com",
  "https://ng.prosple.com/entry-level-jobs-nigeria",
  "https://ng.prosple.com/entry-level-remote-jobs",
  "https://www.myjobmag.com/cp/entry-level-jobs-nigeria",
  "https://ng.jooble.org",
];

// Feed source config now lives in jobFeeds.ts (FEED_SOURCES, isFeedSource) —
// single source of truth so the domain-match list and fetch config can't drift.
export { FEED_SOURCES, isFeedSource } from "./jobFeeds.ts";