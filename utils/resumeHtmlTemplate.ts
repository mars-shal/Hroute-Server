/**
 * Resume HTML Template Generator
 * 
 * Generates ATS-friendly HTML for PDF generation.
 * - Single column layout
 * - Standard section headings
 * - Clean, parseable formatting
 * - No tables, columns, or graphics
 */

import type {
  ResumeSession,
  SkillCategory,
  ExperienceEntry,
  ProjectEntry,
  EducationEntry,
  CertificationEntry,
} from '../controller/resumeBuilder.js';

// ── Types ──────────────────────────────────────────────────────

interface TemplateOptions {
  primaryColor?: string;
  fontFamily?: string;
  fontSize?: string;
  showBorder?: boolean;
}

// ── Default Options ────────────────────────────────────────────

const DEFAULT_OPTIONS: TemplateOptions = {
  primaryColor: '#1a1a1a',
  fontFamily: 'Arial, Helvetica, sans-serif',
  fontSize: '11pt',
  showBorder: false,
};

// ── Main Function ──────────────────────────────────────────────

function generateResumeHtml(
  session: ResumeSession,
  options: TemplateOptions = {}
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  
  const sections: string[] = [];

  // Header
  sections.push(generateHeader(session, opts));

  // Summary
  if (session.summary) {
    sections.push(generateSummary(session.summary, opts));
  }

  // Skills
  if (session.skills.length > 0) {
    sections.push(generateSkills(session.skills, opts));
  }

  // Experience
  if (session.experience.length > 0) {
    sections.push(generateExperience(session.experience, opts));
  }

  // Projects
  if (session.projects.length > 0) {
    sections.push(generateProjects(session.projects, opts));
  }

  // Education
  if (session.education.length > 0) {
    sections.push(generateEducation(session.education, opts));
  }

  // Certifications
  if (session.certifications.length > 0) {
    sections.push(generateCertifications(session.certifications, opts));
  }

  // Wrap in full HTML document
  return wrapInHtmlDocument(sections.join('\n'), opts);
}

// ── Section Generators ─────────────────────────────────────────

function generateHeader(
  session: ResumeSession,
  options: TemplateOptions
): string {
  const contactParts: string[] = [];
  
  if (session.location) contactParts.push(session.location);
  if (session.email) contactParts.push(`<a href="mailto:${session.email}">${session.email}</a>`);
  if (session.phone) contactParts.push(`<a href="tel:${session.phone}">${session.phone}</a>`);
  if (session.linkedin_url) contactParts.push(`<a href="${session.linkedin_url}" target="_blank">LinkedIn</a>`);
  if (session.github_url) contactParts.push(`<a href="${session.github_url}" target="_blank">GitHub</a>`);
  if (session.portfolio_url) contactParts.push(`<a href="${session.portfolio_url}" target="_blank">Portfolio</a>`);

  return `
    <header class="header">
      <h1 class="name">${escapeHtml(session.full_name)}</h1>
      <div class="contact">${contactParts.join(' • ')}</div>
    </header>
  `;
}

function generateSummary(summary: string, options: TemplateOptions): string {
  return `
    <section class="section">
      <h2 class="section-title">Summary</h2>
      <div class="content">
        ${formatMarkdownToHtml(summary)}
      </div>
    </section>
  `;
}

function generateSkills(skills: SkillCategory[], options: TemplateOptions): string {
  const categoriesHtml = skills.map(category => `
    <div class="skill-category">
      <h3 class="skill-category-title">${escapeHtml(category.name)}</h3>
      <ul class="skill-list">
        ${category.skills.map(skill => `<li>${escapeHtml(skill)}</li>`).join('\n')}
      </ul>
    </div>
  `).join('\n');

  return `
    <section class="section">
      <h2 class="section-title">Technical Skills</h2>
      <div class="content">
        ${categoriesHtml}
      </div>
    </section>
  `;
}

function generateExperience(experience: ExperienceEntry[], options: TemplateOptions): string {
  const entriesHtml = experience.map(exp => `
    <div class="experience-entry">
      <div class="entry-header">
        <div class="entry-company">${escapeHtml(exp.company)}</div>
        <div class="entry-role">${escapeHtml(exp.role)}</div>
        <div class="entry-dates">${escapeHtml(exp.start_date)} – ${escapeHtml(exp.end_date)}</div>
      </div>
      <ul class="bullet-list">
        ${exp.bullets.map(bullet => `<li>${escapeHtml(bullet)}</li>`).join('\n')}
      </ul>
    </div>
  `).join('\n');

  return `
    <section class="section">
      <h2 class="section-title">Work Experience</h2>
      <div class="content">
        ${entriesHtml}
      </div>
    </section>
  `;
}

function generateProjects(projects: ProjectEntry[], options: TemplateOptions): string {
  const entriesHtml = projects.map(project => `
    <div class="project-entry">
      <div class="entry-header">
        <div class="entry-company">${escapeHtml(project.name)}</div>
      </div>
      <ul class="bullet-list">
        ${project.description.map(desc => `<li>${escapeHtml(desc)}</li>`).join('\n')}
        ${project.technologies.length > 0 ? `<li class="technologies">Technologies: ${project.technologies.map(t => escapeHtml(t)).join(', ')}</li>` : ''}
      </ul>
    </div>
  `).join('\n');

  return `
    <section class="section">
      <h2 class="section-title">Projects</h2>
      <div class="content">
        ${entriesHtml}
      </div>
    </section>
  `;
}

function generateEducation(education: EducationEntry[], options: TemplateOptions): string {
  const entriesHtml = education.map(edu => `
    <div class="education-entry">
      <div class="entry-header">
        <div class="entry-company">${escapeHtml(edu.institution)}</div>
        <div class="entry-dates">${escapeHtml(edu.year)}</div>
      </div>
      <div class="entry-degree">${escapeHtml(edu.degree)}</div>
    </div>
  `).join('\n');

  return `
    <section class="section">
      <h2 class="section-title">Education</h2>
      <div class="content">
        ${entriesHtml}
      </div>
    </section>
  `;
}

function generateCertifications(certifications: CertificationEntry[], options: TemplateOptions): string {
  const listHtml = certifications.map(cert => `
    <li>${escapeHtml(cert.name)} — ${escapeHtml(cert.issuer)} (${escapeHtml(cert.year)})</li>
  `).join('\n');

  return `
    <section class="section">
      <h2 class="section-title">Certifications</h2>
      <div class="content">
        <ul class="certification-list">
          ${listHtml}
        </ul>
      </div>
    </section>
  `;
}

// ── HTML Document Wrapper ──────────────────────────────────────

function wrapInHtmlDocument(content: string, options: TemplateOptions): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Resume</title>
  <style>
    /* Reset and base styles */
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: ${options.fontFamily};
      font-size: ${options.fontSize};
      line-height: 1.5;
      color: ${options.primaryColor};
      padding: 40px;
      max-width: 800px;
      margin: 0 auto;
    }

    /* Header styles */
    .header {
      text-align: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid #e0e0e0;
    }

    .name {
      font-size: 24pt;
      font-weight: bold;
      margin-bottom: 8px;
      color: #1a1a1a;
    }

    .contact {
      font-size: 10pt;
      color: #444;
    }

    .contact a {
      color: #444;
      text-decoration: none;
    }

    .contact a:hover {
      text-decoration: underline;
    }

    /* Section styles */
    .section {
      margin-bottom: 20px;
    }

    .section-title {
      font-size: 14pt;
      font-weight: bold;
      color: #1a1a1a;
      margin-bottom: 8px;
      padding-bottom: 4px;
      border-bottom: 1px solid #e0e0e0;
    }

    .content {
      margin-left: 0;
    }

    /* Skills styles */
    .skill-category {
      margin-bottom: 8px;
    }

    .skill-category-title {
      font-size: 11pt;
      font-weight: bold;
      margin-bottom: 4px;
    }

    .skill-list {
      list-style: disc;
      margin-left: 20px;
    }

    .skill-list li {
      margin-bottom: 2px;
    }

    /* Experience styles */
    .experience-entry,
    .project-entry,
    .education-entry {
      margin-bottom: 16px;
    }

    .entry-header {
      margin-bottom: 4px;
    }

    .entry-company {
      font-weight: bold;
      font-size: 11pt;
    }

    .entry-role {
      font-style: italic;
      color: #444;
    }

    .entry-dates {
      font-size: 10pt;
      color: #666;
    }

    .entry-degree {
      font-style: italic;
    }

    /* Bullet list styles */
    .bullet-list {
      list-style: disc;
      margin-left: 20px;
    }

    .bullet-list li {
      margin-bottom: 4px;
    }

    .technologies {
      font-style: italic;
      color: #666;
    }

    /* Certification list styles */
    .certification-list {
      list-style: disc;
      margin-left: 20px;
    }

    .certification-list li {
      margin-bottom: 4px;
    }

    /* Print styles */
    @media print {
      body {
        padding: 0;
        max-width: none;
      }

      .section {
        page-break-inside: avoid;
      }
    }
  </style>
</head>
<body>
  ${content}
</body>
</html>
  `;
}

// ── Helper Functions ───────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatMarkdownToHtml(markdown: string): string {
  // Simple markdown to HTML conversion
  let html = markdown;

  // Bold
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');

  // Links
  html = html.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank">$1</a>');

  // Line breaks
  html = html.replace(/\n/g, '<br>');

  return html;
}

// ── Exports ────────────────────────────────────────────────────

export { generateResumeHtml };
export type { TemplateOptions };
