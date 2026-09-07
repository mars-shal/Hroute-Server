/**
 * Job Enricher — LLM-based structured extraction from cleaned descriptions.
 *
 * Takes a clean job description → extracts summary, responsibilities,
 * requirements (required vs preferred), skills (categorized),
 * experience, education, employment type, remote scope.
 *
 * Design principle: one well-prompted extraction call, not multiple.
 * The LLM structures facts — it does not invent or guess.
 */

import { LLM } from "../model/LLM.js";
import { logger } from "./logger.js";

// ── Types ───────────────────────────────────────────────────────

export type SkillCategory = "technical" | "domain" | "tools";

export type ExtractedSkill = {
  name: string;
  category: SkillCategory;
  /** Evidence string from the description that supports this skill */
  evidence: string;
};

export type ExtractedRequirement = {
  text: string;
  type: "required" | "preferred";
};

export type ExtractedExperience = {
  level: "internship" | "entry" | "junior" | "mid" | "senior" | "lead" | "manager" | "director" | "executive" | "unknown";
  min_years: number | null;
  max_years: number | null;
};

export type RemoteScope = "worldwide" | "africa" | "country" | "region" | "city" | "onsite" | "unknown";

export type EnrichedJob = {
  summary: string | null;
  responsibilities: string[];
  requirements: {
    required: string[];
    preferred: string[];
  };
  skills: {
    technical: string[];
    domain: string[];
    tools: string[];
  };
  experience: ExtractedExperience;
  education: string[];
  employment_type: "full-time" | "part-time" | "contract" | "freelance" | "internship" | "unknown";
  remote_scope: RemoteScope;
  /** ISO timestamp of enrichment */
  enriched_at: string;
};

export type EnrichmentResult = {
  success: boolean;
  data: EnrichedJob | null;
  error?: string;
};

// ── Skill canonicalization map ──────────────────────────────────

const SKILL_ALIASES: Record<string, string> = {
  // JavaScript ecosystem
  "nodejs": "Node.js",
  "node": "Node.js",
  "node.js": "Node.js",
  "expressjs": "Express.js",
  "express": "Express.js",
  "reactjs": "React",
  "react.js": "React",
  "vuejs": "Vue.js",
  "vue.js": "Vue.js",
  "angularjs": "Angular",
  "angular.js": "Angular",
  "nextjs": "Next.js",
  "next.js": "Next.js",
  "nuxtjs": "Nuxt.js",
  "nuxt.js": "Nuxt.js",
  "gatsbyjs": "Gatsby",
  "jquery": "jQuery",
  "typescript": "TypeScript",
  "ts": "TypeScript",
  "js": "JavaScript",
  "es6": "JavaScript",
  "ecmascript": "JavaScript",
  "deno": "Deno",
  "bun": "Bun",
  "prisma": "Prisma",
  "typeorm": "TypeORM",
  "sequelize": "Sequelize",
  "mongoose": "Mongoose",
  "redux": "Redux",
  "mobx": "MobX",
  "graphql": "GraphQL",
  "apollo": "Apollo",
  "nestjs": "NestJS",
  "svelte": "Svelte",
  "solidjs": "SolidJS",
  "tailwind": "Tailwind CSS",
  "tailwindcss": "Tailwind CSS",
  "bootstrap": "Bootstrap",
  "sass": "Sass",
  "scss": "Sass",
  "less": "Less",
  "styled-components": "Styled Components",
  "css": "CSS",
  "html5": "HTML",
  "html": "HTML",

  // Python ecosystem
  "python": "Python",
  "py": "Python",
  "django": "Django",
  "flask": "Flask",
  "fastapi": "FastAPI",
  "pytorch": "PyTorch",
  "tensorflow": "TensorFlow",
  "keras": "Keras",
  "pandas": "Pandas",
  "numpy": "NumPy",
  "scikit-learn": "scikit-learn",
  "sklearn": "scikit-learn",
  "jupyter": "Jupyter",
  "celery": "Celery",
  "sqlalchemy": "SQLAlchemy",
  "pytest": "pytest",
  "unittest": "unittest",
  "asyncio": "asyncio",
  "aiogram": "Aiogram",

  // Java ecosystem
  "java": "Java",
  "spring": "Spring",
  "springboot": "Spring Boot",
  "spring boot": "Spring Boot",
  "hibernate": "Hibernate",
  "maven": "Maven",
  "gradle": "Gradle",
  "junit": "JUnit",
  "kotlin": "Kotlin",
  "scala": "Scala",
  "groovy": "Groovy",
  "elasticsearch": "Elasticsearch",
  "kafka": "Apache Kafka",
  "rabbitmq": "RabbitMQ",
  "redis": "Redis",
  "memcached": "Memcached",
  "nginx": "Nginx",

  // Go ecosystem
  "go": "Go",
  "golang": "Go",
  "gin": "Gin",
  "fiber": "Fiber",
  "echo": "Echo (Go)",
  "chi": "Chi",
  "cobra": "Cobra",
  "viper": "Viper",
  "swaggo": "Swaggo",

  // Rust ecosystem
  "rust": "Rust",
  "rustlang": "Rust",
  "cargo": "Cargo",
  "serde": "Serde",
  "tokio": "Tokio",
  "axum": "Axum",
  "actix": "Actix",
  "rocket": "Rocket (Rust)",
  "tower": "Tower",
  "tonic": "Tonic",

  // Cloud & DevOps
  "aws": "AWS",
  "amazon web services": "AWS",
  "gcp": "Google Cloud",
  "google cloud": "Google Cloud",
  "google cloud platform": "Google Cloud",
  "azure": "Azure",
  "microsoft azure": "Azure",
  "heroku": "Heroku",
  "vercel": "Vercel",
  "netlify": "Netlify",
  "cloudflare": "Cloudflare",
  "docker": "Docker",
  "kubernetes": "Kubernetes",
  "k8s": "Kubernetes",
  "terraform": "Terraform",
  "ansible": "Ansible",
  "pulumi": "Pulumi",
  "jenkins": "Jenkins",
  "circleci": "CircleCI",
  "github actions": "GitHub Actions",
  "gitlab ci": "GitLab CI",
  "travis ci": "Travis CI",
  "helm": "Helm",
  "prometheus": "Prometheus",
  "grafana": "Grafana",
  "datadog": "Datadog",
  "new relic": "New Relic",
  "sentry": "Sentry",
  "opentelemetry": "OpenTelemetry",
  "istio": "Istio",
  "envoy": "Envoy",
  "consul": "Consul",
  "vault": "Vault (HashiCorp)",
  "nomad": "Nomad",
  "packer": "Packer",

  // Databases
  "postgresql": "PostgreSQL",
  "postgres": "PostgreSQL",
  "psql": "PostgreSQL",
  "mysql": "MySQL",
  "mariadb": "MariaDB",
  "sqlite": "SQLite",
  "sqlserver": "SQL Server",
  "mssql": "SQL Server",
  "mongodb": "MongoDB",
  "mongo": "MongoDB",
  "cassandra": "Cassandra",
  "dynamodb": "DynamoDB",
  "firestore": "Firestore",
  "supabase": "Supabase",
  "firebase": "Firebase",
  "neo4j": "Neo4j",
  "couchbase": "Couchbase",
  "cockroachdb": "CockroachDB",
  "clickhouse": "ClickHouse",
  "snowflake": "Snowflake",
  "bigquery": "BigQuery",
  "redshift": "Redshift",
  "airflow": "Airflow",
  "dbt": "dbt",
  "spark": "Apache Spark",
  "hadoop": "Hadoop",
  "hive": "Hive",
  "presto": "Presto",
  "trino": "Trino",
  "flink": "Apache Flink",
  "kinesis": "Kinesis",

  // Other
  "git": "Git",
  "github": "GitHub",
  "gitlab": "GitLab",
  "bitbucket": "Bitbucket",
  "linux": "Linux",
  "unix": "Unix",
  "bash": "Bash",
  "shell": "Shell Scripting",
  "zsh": "Zsh",
  "powershell": "PowerShell",
  "rest": "REST APIs",
  "rest api": "REST APIs",
  "graphql api": "GraphQL",
  "grpc": "gRPC",
  "websocket": "WebSocket",
  "websockets": "WebSocket",
  "oauth": "OAuth",
  "oauth2": "OAuth 2.0",
  "jwt": "JWT",
  "saml": "SAML",
  "ldap": "LDAP",
  "sso": "SSO",
  "ci/cd": "CI/CD",
  "cicd": "CI/CD",
  "tdd": "TDD",
  "agile": "Agile",
  "scrum": "Scrum",
  "kanban": "Kanban",
  "jira": "Jira",
  "confluence": "Confluence",
  "figma": "Figma",
  "sketch": "Sketch",
  "adobe xd": "Adobe XD",
  "photoshop": "Photoshop",
  "illustrator": "Illustrator",
  "api": "API Development",
  "microservices": "Microservices",
  "micro service": "Microservices",
  "micro-service": "Microservices",
  "serverless": "Serverless",
  "ml": "Machine Learning",
  "machine learning": "Machine Learning",
  "deep learning": "Deep Learning",
  "nlp": "NLP",
  "computer vision": "Computer Vision",
  "llm": "LLMs",
  "large language model": "LLMs",
  "large language models": "LLMs",
  "generative ai": "Generative AI",
  "gen ai": "Generative AI",
  "genai": "Generative AI",
  "data science": "Data Science",
  "data engineering": "Data Engineering",
  "data pipeline": "Data Pipelines",
  "etl": "ETL",
  "data warehouse": "Data Warehousing",
  "data lake": "Data Lake",
  "blockchain": "Blockchain",
  "smart contract": "Smart Contracts",
  "solidity": "Solidity",
  "web3": "Web3",
  "react native": "React Native",
  "flutter": "Flutter",
  "dart": "Dart",
  "swift": "Swift",
  "kotlin android": "Kotlin (Android)",
  "android": "Android Development",
  "ios": "iOS Development",
  "c#": "C#",
  "csharp": "C#",
  ".net": ".NET",
  "dotnet": ".NET",
  "asp.net": "ASP.NET",
  "blazor": "Blazor",
  "xamarin": "Xamarin",
  "unity": "Unity",
  "unreal": "Unreal Engine",
  "c++": "C++",
  "cpp": "C++",
  "c": "C",
  "php": "PHP",
  "laravel": "Laravel",
  "symfony": "Symfony",
  "wordpress": "WordPress",
  "drupal": "Drupal",
  "shopify": "Shopify",
  "ruby": "Ruby",
  "rails": "Ruby on Rails",
  "ruby on rails": "Ruby on Rails",
  "r": "R",
  "matlab": "MATLAB",
  "swiftui": "SwiftUI",
  "ui": "UI Design",
  "ux": "UX Design",
  "ui/ux": "UI/UX Design",
  "product management": "Product Management",
  "project management": "Project Management",
  "pm": "Project Management",
  "sre": "SRE",
  "devops": "DevOps",
  "devsecops": "DevSecOps",
  "platform engineering": "Platform Engineering",
  "finops": "FinOps",
  "salesforce": "Salesforce",
  "sap": "SAP",
  "oracle": "Oracle",
  "servicenow": "ServiceNow",
  "hubspot": "HubSpot",
  "stripe": "Stripe",
  "paypal": "PayPal",
  "square": "Square",
  "plaid": "Plaid",
  "twilio": "Twilio",
  "sendgrid": "SendGrid",
  "mandrill": "Mandrill",
  "segment": "Segment",
  "amplitude": "Amplitude",
  "mixpanel": "Mixpanel",
  "hotjar": "Hotjar",
  "fullstory": "FullStory",
  "intercom": "Intercom",
  "zendesk": "Zendesk",
  "stripe api": "Stripe",
};

function canonicalizeSkill(raw: string): string {
  const key = raw.toLowerCase().trim().replace(/[^a-z0-9.+_/-]/g, "");
  return SKILL_ALIASES[key] ?? raw.trim();
}

function categorizeSkill(name: string): SkillCategory {
  const TECHNICAL_KEYWORDS = [
    "javascript", "typescript", "python", "java", "go", "rust", "c++", "c#",
    "php", "ruby", "swift", "kotlin", "scala", "dart", "r", "matlab",
    "react", "angular", "vue", "svelte", "node.js", "deno", "bun",
    "next.js", "nuxt.js", "express.js", "django", "flask", "fastapi",
    "spring boot", "laravel", "rails", "asp.net", "blazor",
    "pytorch", "tensorflow", "keras", "scikit-learn",
    "machine learning", "deep learning", "nlp", "computer vision",
    "llms", "generative ai", "data science",
    "graphql", "rest apis", "grpc", "websocket", "oauth",
    "react native", "flutter", "swiftui",
    "sql", "nosql", "postgresql", "mysql", "mongodb", "redis", "elasticsearch",
  ];

  const TOOLS_KEYWORDS = [
    "docker", "kubernetes", "terraform", "ansible", "helm",
    "aws", "google cloud", "azure", "cloudflare", "vercel", "netlify",
    "jenkins", "circleci", "github actions", "gitlab ci",
    "prometheus", "grafana", "datadog", "sentry", "new relic",
    "git", "github", "gitlab", "bitbucket", "jira", "confluence",
    "figma", "sketch", "photoshop",
    "airflow", "dbt", "spark", "kafka", "rabbitmq",
    "postman", "swagger", "notion", "slack",
  ];

  const lower = name.toLowerCase();
  if (TOOLS_KEYWORDS.some(k => lower.includes(k))) return "tools";
  if (TECHNICAL_KEYWORDS.some(k => lower.includes(k))) return "technical";
  return "domain";
}

const ENRICH_PROMPT = `Extract structured information from this job description.

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "summary": "2-4 sentence summary of the role",
  "responsibilities": ["list of key responsibilities"],
  "requirements_required": ["required qualifications - things the candidate MUST have"],
  "requirements_preferred": ["preferred/nice-to-have qualifications"],
  "skills_technical": ["programming languages, frameworks, databases, cloud platforms"],
  "skills_tools": ["dev tools, CI/CD, monitoring, design tools, project management"],
  "skills_domain": ["domain knowledge, industry expertise, soft skills, business skills"],
  "experience_level": "internship|entry|junior|mid|senior|lead|manager|director|executive|unknown",
  "experience_min_years": null or number,
  "experience_max_years": null or number,
  "education": ["required education qualifications"],
  "employment_type": "full-time|part-time|contract|freelance|internship|unknown",
  "remote_scope": "worldwide|africa|country|region|city|onsite|unknown",
  "candidate_locations": ["countries or regions the candidate can be based in"]
}

Guidelines:
- summary: capture what the role does, who they're looking for, and the impact
- responsibilities: extract concrete duties, not generic filler
- requirements_required: only things stated as required/must-have/essential
- requirements_preferred: things stated as preferred/nice-to-have/plus/optional
- For skills: extract explicitly mentioned skills only. Do NOT infer.
  - If a skill appears but isn't explicitly named, don't include it.
- experience_level: classify from title + description signals
- remote_scope: "worldwide" if open to any location, "country" if restricted to one country, "region" if continent/region, "city" if specific metro, "onsite" if not remote
- candidate_locations: if explicitly stated (e.g. "must be in Nigeria", "EMEA only"), list them. Otherwise [].

JOB DESCRIPTION:
`;

/**
 * Enrich a cleaned job description using the LLM.
 *
 * Uses a single well-prompted extraction call. Post-processes skills
 * through canonicalization and categorization.
 */
export async function enrichJob(
  descriptionClean: string,
  title?: string,
  llm?: LLM,
): Promise<EnrichmentResult> {
  const model = llm ?? new LLM();

  if (!descriptionClean || descriptionClean.trim().length < 50) {
    return {
      success: false,
      data: null,
      error: `Description too short (${(descriptionClean ?? "").length} chars)`,
    };
  }

  const truncated = descriptionClean.length > 5000
    ? descriptionClean.slice(0, 5000)
    : descriptionClean;

  const prompt = `${ENRICH_PROMPT}${title ? `\nTitle: ${title}\n\n` : ""}${truncated}`;

  try {
    const result = await model.structured<Record<string, unknown>>(
      prompt,
      (raw: string) => {
        const cleaned = raw.replace(/```(?:json)?\s*/gi, "").trim();
        return JSON.parse(cleaned) as Record<string, unknown>;
      },
      { temperature: 0.1, max_tokens: 2048, caller: "jobEnrichment" },
    );

    // Normalize arrays
    const normalizeArr = (v: unknown): string[] => {
      if (Array.isArray(v)) return v.map(i => String(i).trim()).filter(Boolean);
      if (typeof v === "string") return [v];
      return [];
    };

    // Extract and canonicalize skills
    const rawTechnical = normalizeArr(result.skills_technical);
    const rawDomain = normalizeArr(result.skills_domain);
    const rawTools = normalizeArr(result.skills_tools);

    const canonicalize = (skills: string[]): string[] =>
      [...new Set(skills.map(canonicalizeSkill).filter(Boolean))];

    const skills = {
      technical: canonicalize(rawTechnical),
      domain: canonicalize(rawDomain),
      tools: canonicalize(rawTools),
    };

    // Deduplicate across categories — if a skill appears in multiple,
    // keep it in the most specific category
    const all = new Set<string>();
    for (const s of skills.technical) all.add(s.toLowerCase());
    skills.domain = skills.domain.filter(s => !all.has(s.toLowerCase()));
    for (const s of skills.domain) all.add(s.toLowerCase());
    skills.tools = skills.tools.filter(s => !all.has(s.toLowerCase()));

    const enriched: EnrichedJob = {
      summary: String(result.summary ?? "").trim() || null,
      responsibilities: normalizeArr(result.responsibilities),
      requirements: {
        required: normalizeArr(result.requirements_required),
        preferred: normalizeArr(result.requirements_preferred),
      },
      skills,
      experience: {
        level: (["internship", "entry", "junior", "mid", "senior", "lead", "manager", "director", "executive"] as const)
          .includes(result.experience_level as string)
          ? result.experience_level as EnrichedJob["experience"]["level"]
          : "unknown",
        min_years: typeof result.experience_min_years === "number" ? result.experience_min_years : null,
        max_years: typeof result.experience_max_years === "number" ? result.experience_max_years : null,
      },
      education: normalizeArr(result.education),
      employment_type: (["full-time", "part-time", "contract", "freelance", "internship"] as const)
        .includes(result.employment_type as string)
        ? result.employment_type as EnrichedJob["employment_type"]
        : "unknown",
      remote_scope: (["worldwide", "africa", "country", "region", "city", "onsite"] as const)
        .includes(result.remote_scope as string)
        ? result.remote_scope as RemoteScope
        : "unknown",
      enriched_at: new Date().toISOString(),
    };

    return { success: true, data: enriched };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`[JobEnricher] Enrichment failed: ${msg}`);
    return { success: false, data: null, error: msg };
  }
}
