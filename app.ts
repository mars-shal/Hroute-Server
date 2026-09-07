import express, { type Request, type Response } from "express";
import { createServer, type Server as HttpServer } from "http";
import type { DatabaseLike } from "./model/database.js";
import { createApiRouter } from "./controller/apiController.js";
import { generateResumeHtml } from "./utils/resumeHtmlTemplate.js";
import type { ResumeDisplayData } from './utils/resumeHtmlTemplate.js';
import { htmlToPdf } from "./utils/pdfGenerator.js";

// ── Demo Resume Data ────────────────────────────────────────

const DEMO_RESUME: ResumeDisplayData = {
  full_name: "Sarah Chen",
  email: "sarah.chen@example.com",
  phone: "+1 (555) 234-5678",
  location: "San Francisco, CA",
  linkedin_url: "https://linkedin.com/in/sarahchen",
  github_url: "https://github.com/sarahchen",
  portfolio_url: "https://sarahchen.dev",
  summary:
    "Senior full-stack engineer with **8+ years** building scalable web applications at SaaS companies. "
    + "Specialize in React, TypeScript, and Node.js ecosystems with a strong focus on [performance optimization](https://example.com/perf-blog) and developer tooling. "
    + "Led frontend architecture for a Series B startup through 3x user growth. Open-source contributor to popular linting tools.",
  skills: [
    {
      name: "Languages",
      skills: ["TypeScript", "JavaScript", "Python", "SQL", "GraphQL"],
    },
    {
      name: "Frontend",
      skills: ["React", "Next.js", "Tailwind CSS", "Redux", "React Query", "Vitest"],
    },
    {
      name: "Backend",
      skills: ["Node.js", "Express", "PostgreSQL", "Redis", "AWS Lambda", "Docker"],
    },
    {
      name: "Tools",
      skills: ["Git", "GitHub Actions", "Terraform", "Datadog", "Figma"],
    },
  ],
  experience: [
    {
      company: "Orbital Systems",
      role: "Senior Frontend Engineer",
      start_date: "2022-03",
      end_date: "Present",
      bullets: [
        "Led frontend migration from Angular to React, reducing bundle size by 60% and improving Lighthouse score from 42 to 89",
        "Designed and implemented a component library with 40+ accessible UI components used across 3 product teams",
        "Built real-time collaborative editing features using CRDTs and WebSockets, serving 15k+ daily active users",
        "Established CI/CD pipeline with automated visual regression testing, cutting regressions by 80%",
        "Mentored 4 junior engineers through structured code reviews and weekly pair programming sessions",
      ],
    },
    {
      company: "DataStream Inc.",
      role: "Full-Stack Developer",
      start_date: "2019-06",
      end_date: "2022-02",
      bullets: [
        "Architected RESTful API layer serving 10M+ monthly requests with 99.9% uptime on AWS ECS",
        "Built real-time dashboard with WebSocket-powered live updates, adopted by 200+ enterprise customers",
        "Reduced database query latency by 70% through strategic indexing and query optimization in PostgreSQL",
        "Implemented OAuth 2.0 flow supporting Google, GitHub, and SAML SSO for enterprise tenants",
      ],
    },
    {
      company: "WebCraft Agency",
      role: "Junior Developer",
      start_date: "2017-01",
      end_date: "2019-05",
      bullets: [
        "Delivered 15+ client websites using React, Gatsby, and WordPress with custom theme development",
        "Built custom CMS plugins in PHP, serving 500k+ monthly visitors across client sites",
        "Automated build and deployment workflows with Webpack, Babel, and Docker, reducing release time by 40%",
      ],
    },
  ],
  projects: [
    {
      name: "eslint-plugin-perf",
      description: [
        "Published ESLint plugin with 12 performance-focused rules detecting common React anti-patterns",
        "2,500+ weekly downloads on npm; adopted by 3 enterprise teams",
      ],
      technologies: ["TypeScript", "AST", "ESLint", "Vitest", "GitHub Actions"],
    },
    {
      name: "Hackathon: Transit Mapper",
      description: [
        "Real-time SF MUNI tracking app using GTFS streaming data, React Native, and Mapbox GL",
        "Won \"Best Use of Public Data\" at SF Hackathon 2023",
      ],
      technologies: ["React Native", "Mapbox", "Node.js", "WebSocket"],
    },
  ],
  education: [
    {
      institution: "University of California, Berkeley",
      degree: "B.S. Computer Science",
      year: "2017",
    },
  ],
  certifications: [
    { name: "AWS Solutions Architect – Associate", issuer: "Amazon Web Services", year: "2023" },
    { name: "Google Cloud Professional Developer", issuer: "Google Cloud", year: "2022" },
  ],
};

// ── App Factory ──────────────────────────────────────────────

type AppDeps = {
  api?: Parameters<typeof createApiRouter>[1];
};

export function createApp(db: DatabaseLike, deps: AppDeps = {}) {
  const app = express();

  app.use(express.json({ limit: "3mb" }));

  app.use((_req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (_req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.get("/ping", (_req: Request, res: Response) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Demo resume preview
  app.get("/resume/demo", (_req: Request, res: Response) => {
    const html = generateResumeHtml(DEMO_RESUME, { showBorder: true });
    res.type("html").send(html);
  });

  // Demo resume PDF export
  app.get("/resume/demo/pdf", async (_req: Request, res: Response) => {
    try {
      const html = generateResumeHtml(DEMO_RESUME, { showBorder: true });
      const pdf = await htmlToPdf(html);
      res.type("application/pdf").send(Buffer.from(pdf));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).type("text").send(`PDF generation failed: ${msg}`);
    }
  });

  app.use("/api", createApiRouter(db, deps.api));

  return app;
}

export function createHttpServer(db: DatabaseLike, deps: AppDeps = {}): HttpServer {
  const app = createApp(db, deps);
  return createServer(app);
}
