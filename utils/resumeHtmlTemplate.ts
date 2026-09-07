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

/** Display fields the template needs — ResumeSession and the demo resume
 * both satisfy this; the render server receives the full session anyway. */
export type ResumeDisplayData = Pick<
  ResumeSession,
  | 'full_name' | 'email' | 'phone' | 'location'
  | 'linkedin_url' | 'github_url' | 'portfolio_url'
  | 'summary' | 'skills' | 'experience' | 'projects' | 'education' | 'certifications'
>;

function generateResumeHtml(
  session: ResumeDisplayData,
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

// ── Entry Header Helper ─────────────────────────────────────

function generateEntryHeader(title: string, subtitle?: string, dates?: string): string {
  return `
      <div class="entry-header">
        <div class="entry-title-row">
          <span class="entry-title">${escapeHtml(title)}</span>
          ${dates ? `<span class="entry-dates">${escapeHtml(dates)}</span>` : ''}
        </div>
        ${subtitle ? `<div class="entry-subtitle">${escapeHtml(subtitle)}</div>` : ''}
      </div>`;
}

// ── Section Generators ─────────────────────────────────────────

function generateHeader(
  session: ResumeDisplayData,
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
      <div class="contact">${contactParts.join(' | ')}</div>
    </header>
  `;
}

function generateSummary(summary: string, options: TemplateOptions): string {
  return `
    <section class="section">
      <h2 class="section-title">Summary</h2>
      <div class="content">
        ${formatMarkdownToHtml(escapeHtml(summary))}
      </div>
    </section>
  `;
}

function generateSkills(skills: SkillCategory[], options: TemplateOptions): string {
  const categoriesHtml = skills.map(category => `
    <div class="skill-category">
      <p class="skill-line"><strong class="skill-category-title">${escapeHtml(category.name)}:</strong> ${category.skills.map(skill => escapeHtml(skill)).join(', ')}</p>
    </div>
  `).join('\n');

  return `
    <section class="section">
      <h2 class="section-title">Skills</h2>
      <div class="content">
        ${categoriesHtml}
      </div>
    </section>
  `;
}

function generateExperience(experience: ExperienceEntry[], options: TemplateOptions): string {
  const entriesHtml = experience.map(exp => {
    const dates = exp.start_date && exp.end_date ? `${exp.start_date} – ${exp.end_date}` : undefined;
    return `
    <div class="experience-entry">
      ${generateEntryHeader(exp.company, exp.role, dates)}
      <ul class="bullet-list">
        ${exp.bullets.map(bullet => `<li>${escapeHtml(bullet)}</li>`).join('\n')}
      </ul>
    </div>`;
  }).join('\n');

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
      ${generateEntryHeader(project.name)}
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
      ${generateEntryHeader(edu.institution, edu.degree, edu.year)}
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
	    @page {
	      size: A4;
	      margin: 20mm 15mm;
	    }

	    :root {
	      --color-primary: ${options.primaryColor};
	      --color-text: #333;
	      --color-muted: #555;
	      --color-faint: #777;
	      --color-border: #ccc;
	      --font-display: Calibri, 'Segoe UI', Arial, Helvetica, sans-serif;
	      --font-body: Arial, Helvetica, sans-serif;
	      --space-1: 4px;
	      --space-2: 8px;
	      --space-3: 12px;
	      --space-4: 16px;
	      --space-5: 24px;
	      --space-6: 32px;
	      --scale-1: 10pt;
	      --scale-2: 11pt;
	      --scale-3: 13.75pt;
	      --scale-4: 17.5pt;
	      --scale-5: 22pt;
	      ${options.showBorder ? '--border-width: 1px;' : '--border-width: 0;'}
	    }

	    * { margin: 0; padding: 0; box-sizing: border-box; }

	    body {
	      font-family: var(--font-body);
	      font-size: var(--scale-2);
	      line-height: 1.5;
	      color: var(--color-text);
	      padding: var(--space-5) var(--space-6);
	      max-width: 800px;
	      margin: 0 auto;
	    }

	    .header {
	      margin-bottom: var(--space-5);
	      padding-bottom: var(--space-4);
	      border-bottom: var(--border-width, 1px) solid var(--color-border);
	    }

	    .name {
	      font-family: var(--font-display);
	      font-size: var(--scale-5);
	      font-weight: 700;
	      color: var(--color-primary);
	      margin-bottom: var(--space-1);
	      letter-spacing: -0.02em;
	    }

	    .contact {
	      font-size: var(--scale-1);
	      color: var(--color-muted);
	    }

	    .contact a { color: var(--color-muted); text-decoration: none; }
	    .contact a:hover { text-decoration: underline; }

	    .section {
	      margin-bottom: var(--space-5);
	    }

	    .section-title {
	      font-family: var(--font-display);
	      font-size: var(--scale-3);
	      font-weight: 600;
	      color: var(--color-primary);
	      margin-bottom: var(--space-3);
	      padding-bottom: var(--space-1);
	      border-bottom: var(--border-width, 1px) solid var(--color-border);
	      text-transform: uppercase;
	      letter-spacing: 0.08em;
	    }

	    .content { margin-left: 0; }

	    .skill-category { margin-bottom: var(--space-1); }
	    .skill-line {
	      font-size: var(--scale-2);
	      line-height: 1.6;
	      margin: 0;
	    }
	    .skill-category-title {
	      font-family: var(--font-display);
	      font-weight: 600;
	      color: var(--color-primary);
	    }

	    .experience-entry,
	    .project-entry,
	    .education-entry {
	      margin-bottom: var(--space-4);
	      page-break-inside: avoid;
	    }

	    .entry-header { margin-bottom: var(--space-1); }
	    .entry-title-row {
	      display: flex;
	      justify-content: space-between;
	      align-items: baseline;
	    }
	    .entry-title {
	      font-family: var(--font-display);
	      font-size: var(--scale-2);
	      font-weight: 700;
	      color: var(--color-primary);
	    }
	    .entry-subtitle {
	      font-size: var(--scale-2);
	      color: var(--color-muted);
	      margin-top: 2px;
	    }
	    .entry-dates {
	      font-size: var(--scale-1);
	      color: var(--color-faint);
	      white-space: nowrap;
	    }

	    .bullet-list { list-style: disc; margin-left: 20px; }
	    .bullet-list li { margin-bottom: var(--space-1); }
	    .technologies { font-style: italic; color: var(--color-faint); }

	    .certification-list { list-style: disc; margin-left: 20px; }
	    .certification-list li { margin-bottom: var(--space-1); }

	    @media print {
	      body { padding: 0; max-width: none; }
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
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return text.replace(/[&<>"']/g, c => map[c] ?? c);
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
