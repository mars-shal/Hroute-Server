/**
 * ATS (Applicant Tracking System) Scorer
 * 
 * Evaluates resumes against ATS compatibility criteria:
 * - Standard section headings
 * - Single column layout
 * - Keywords matching
 * - Clean formatting
 * - Quantified achievements
 * - Google XYZ format compliance
 * 
 * Scoring: 10 sections × 10 points = Max 100
 */

// ── Types ──────────────────────────────────────────────────────

interface ATSScoreResult {
  readonly score: number;
  readonly grade: 'A' | 'B' | 'C' | 'D' | 'F';
  readonly sections: readonly SectionScore[];
  readonly issues: readonly ATSIssue[];
  readonly suggestions: readonly string[];
}

interface SectionScore {
  readonly name: string;
  readonly score: number;
  readonly maxScore: number;
  readonly passed: boolean;
  readonly details: string;
}

interface ATSIssue {
  readonly category: 'formatting' | 'content' | 'structure' | 'keywords';
  readonly severity: 'high' | 'medium' | 'low';
  readonly description: string;
}

// ── Constants ──────────────────────────────────────────────────

const REQUIRED_SECTIONS = [
  'summary',
  'skills',
  'experience',
  'education',
] as const;

type SectionPatternKey = 'summary' | 'skills' | 'experience' | 'education' | 'projects' | 'certifications';

const STANDARD_SECTION_PATTERNS: Record<SectionPatternKey, RegExp[]> = {
  summary: [
    /^#\s+(professional\s+)?summary/im,
    /^#\s+(career\s+)?objective/im,
    /^#\s+profile/im,
  ],
  skills: [
    /^#\s+(technical\s+)?skills?/im,
    /^#\s+core\s+competencies/im,
    /^#\s+technologies/im,
    /^#\s+technical\s+proficiencies/im,
  ],
  experience: [
    /^#\s+(work\s+)?experience/im,
    /^#\s+professional\s+experience/im,
    /^#\s+employment\s+history/im,
    /^#\s+career\s+history/im,
  ],
  education: [
    /^#\s+education/im,
    /^#\s+academic\s+background/im,
    /^#\s+degrees/im,
  ],
  projects: [
    /^#\s+projects?/im,
    /^#\s+portfolio/im,
    /^#\s+key\s+projects/im,
  ],
  certifications: [
    /^#\s+certifications?/im,
    /^#\s+licenses?/im,
    /^#\s+credentials/im,
  ],
};

const ACTION_VERBS = new Set([
  // Leadership
  'led', 'managed', 'directed', 'supervised', 'coordinated', 'mentored',
  'trained', 'guided', 'oversaw', 'headed', 'spearheaded', 'championed',
  
  // Achievement
  'achieved', 'attained', 'exceeded', 'surpassed', 'outperformed',
  'delivered', 'completed', 'accomplished', 'successfully',
  
  // Technical
  'developed', 'built', 'designed', 'implemented', 'architected',
  'engineered', 'programmed', 'coded', 'deployed', 'automated',
  
  // Analysis
  'analyzed', 'evaluated', 'assessed', 'identified', 'discovered',
  'researched', 'investigated', 'diagnosed', 'troubleshot',
  
  // Improvement
  'improved', 'enhanced', 'optimized', 'streamlined', 'increased',
  'reduced', 'decreased', 'minimized', 'maximized', 'accelerated',
  
  // Creation
  'created', 'established', 'founded', 'launched', 'initiated',
  'introduced', 'pioneered', 'conceptualized',
  
  // Communication
  'presented', 'communicated', 'collaborated', 'negotiated',
  'influenced', 'persuaded', 'advocated',
]);

const XYZ_INDICATORS = [
  /accomplished/i,
  /achieved/i,
  /delivered/i,
  /resulted?\s+in/i,
  /leading\s+to/i,
  /contribut(ed|ing)\s+to/i,
  /measured\s+by/i,
  /by\s+(doing|using|leveraging|implementing)/i,
];

const QUANTIFICATION_PATTERNS = [
  /\d+%/,
  /\$[\d,]+/,
  /\d+\+?\s*(users?|customers?|clients?|accounts?|projects?|team\s+members?)/i,
  /\d+\s*(hours?|days?|weeks?|months?|years?)/i,
  /\d+\s*(times?|x)/i,
  /\d+\.\d+/,
  /\b\d{1,3}(,\d{3})+\b/,
];

const LENGTH_THRESHOLDS = {
  optimal: { min: 1000, max: 3500 },
  acceptable: { min: 500, max: 5000 },
} as const;

// ── Main Scoring Function ──────────────────────────────────────

function scoreResume(
  resumeText: string,
  jobDescription?: string
): ATSScoreResult {
  const sections: SectionScore[] = [];
  const issues: ATSIssue[] = [];
  const suggestions: string[] = [];

  // Score each section
  sections.push(scoreContactInfo(resumeText, issues, suggestions));
  sections.push(scoreSummary(resumeText, issues, suggestions));
  sections.push(scoreSkills(resumeText, issues, suggestions));
  sections.push(scoreExperience(resumeText, issues, suggestions));
  sections.push(scoreEducation(resumeText, issues, suggestions));
  sections.push(scoreProjects(resumeText, issues, suggestions));
  sections.push(scoreCertifications(resumeText, issues, suggestions));
  sections.push(scoreFormatting(resumeText, issues, suggestions));
  sections.push(scoreKeywords(resumeText, jobDescription, issues, suggestions));
  sections.push(scoreLength(resumeText, issues, suggestions));

  // Calculate total score
  const totalScore = sections.reduce((sum, s) => sum + s.score, 0);
  const maxScore = sections.reduce((sum, s) => sum + s.maxScore, 0);
  const percentage = Math.round((totalScore / maxScore) * 100);

  // Determine grade
  const grade = determineGrade(percentage);

  // Add final suggestions based on score
  if (percentage < 70) {
    suggestions.push('Focus on adding quantified achievements with specific metrics');
    suggestions.push('Ensure all section headings are standard (Summary, Skills, Experience, Education)');
  }
  if (percentage < 85) {
    suggestions.push('Use Google XYZ format: "Accomplished [X] as measured by [Y], by doing [Z]"');
    suggestions.push('Add more action verbs at the start of bullet points');
  }

  return {
    score: percentage,
    grade,
    sections,
    issues,
    suggestions: [...new Set(suggestions)], // deduplicate
  };
}

// ── Section Scorers ────────────────────────────────────────────

function scoreContactInfo(
  text: string,
  issues: ATSIssue[],
  suggestions: string[]
): SectionScore {
  let score = 0;
  const details: string[] = [];

  // Check for name (first non-empty line — generated resumes use `# Full Name`)
  const lines = text.split('\n').filter(l => l.trim());
  const firstLine = lines[0] ?? '';
  if (firstLine && /[a-zA-Z]/.test(firstLine) && !/^[-–—•]/.test(firstLine.trim())) {
    score += 3;
    details.push('Name present');
  }

  // Check for email
  const emailRegex = /[\w.-]+@[\w.-]+\.\w+/;
  if (emailRegex.test(text)) {
    score += 2;
    details.push('Email present');
  } else {
    issues.push({
      category: 'content',
      severity: 'high',
      description: 'Missing email address',
    });
    suggestions.push('Add your email address to the header');
  }

  // Check for phone
  const phoneRegex = /[\+]?[\d\s\-\(\)]{10,}/;
  if (phoneRegex.test(text)) {
    score += 2;
    details.push('Phone present');
  } else {
    issues.push({
      category: 'content',
      severity: 'medium',
      description: 'Missing phone number',
    });
    suggestions.push('Add your phone number to the header');
  }

  // Check for LinkedIn
  const linkedinRegex = /linkedin\.com\/in\/[\w-]+/i;
  if (linkedinRegex.test(text)) {
    score += 2;
    details.push('LinkedIn present');
  } else {
    issues.push({
      category: 'content',
      severity: 'medium',
      description: 'Missing LinkedIn profile',
    });
    suggestions.push('Add your LinkedIn profile URL');
  }

  // Check for location
  const locationRegex = /(?:location|city|state|country):\s*[\w\s,]+/i;
  if (locationRegex.test(text)) {
    score += 1;
    details.push('Location present');
  }

  return {
    name: 'Contact Information',
    score,
    maxScore: 10,
    passed: score >= 7,
    details: details.join(', ') || 'Missing contact information',
  };
}

function scoreSummary(
  text: string,
  issues: ATSIssue[],
  suggestions: string[]
): SectionScore {
  let score = 0;
  const details: string[] = [];

  // Check if summary section exists
  const hasSummary = STANDARD_SECTION_PATTERNS.summary.some(p => p.test(text));
  if (!hasSummary) {
    issues.push({
      category: 'structure',
      severity: 'high',
      description: 'Missing Summary/Objective section',
    });
    suggestions.push('Add a Professional Summary section at the top');
    return {
      name: 'Summary',
      score: 0,
      maxScore: 10,
      passed: false,
      details: 'Section missing',
    };
  }

  score += 3;
  details.push('Section exists');

  // Extract summary content
  const summaryMatch = text.match(/#\s+(?:professional\s+)?(?:summary|objective|profile)\s*\n([\s\S]*?)(?=\n#\s|\n---|\n$)/i);
  if (summaryMatch) {
    const summaryContent = summaryMatch[1] ?? '';
    const wordCount = summaryContent.split(/\s+/).filter(w => w).length;

    // Check length (2-4 sentences ideal)
    if (wordCount >= 20 && wordCount <= 100) {
      score += 3;
      details.push('Good length');
    } else if (wordCount < 20) {
      issues.push({
        category: 'content',
        severity: 'medium',
        description: 'Summary is too short',
      });
      suggestions.push('Expand your summary to 2-4 sentences');
    } else {
      issues.push({
        category: 'content',
        severity: 'medium',
        description: 'Summary is too long',
      });
      suggestions.push('Keep your summary concise (2-4 sentences)');
    }

    // Check for quantified achievements
    const hasQuantification = QUANTIFICATION_PATTERNS.some(p => p.test(summaryContent));
    if (hasQuantification) {
      score += 2;
      details.push('Quantified achievements');
    } else {
      suggestions.push('Add quantified achievements to your summary');
    }

    // Check for action verbs
    const sentences = summaryContent.split(/[.!?]+/).filter(s => s.trim());
    const hasActionVerb = sentences.some(s => {
      const firstWord = s.trim().split(/\s+/)[0]?.toLowerCase();
      return firstWord && ACTION_VERBS.has(firstWord);
    });
    if (hasActionVerb) {
      score += 2;
      details.push('Action verbs used');
    } else {
      suggestions.push('Start sentences with strong action verbs');
    }
  }

  return {
    name: 'Summary',
    score,
    maxScore: 10,
    passed: score >= 7,
    details: details.join(', '),
  };
}

function scoreSkills(
  text: string,
  issues: ATSIssue[],
  suggestions: string[]
): SectionScore {
  let score = 0;
  const details: string[] = [];

  // Check if skills section exists
  const hasSkills = STANDARD_SECTION_PATTERNS.skills.some(p => p.test(text));
  if (!hasSkills) {
    issues.push({
      category: 'structure',
      severity: 'high',
      description: 'Missing Skills section',
    });
    suggestions.push('Add a Skills/Technical Proficiencies section');
    return {
      name: 'Skills',
      score: 0,
      maxScore: 10,
      passed: false,
      details: 'Section missing',
    };
  }

  score += 3;
  details.push('Section exists');

  // Extract skills content
  const skillsMatch = text.match(/#\s+(?:technical\s+)?(?:skills?|core\s+competencies|technologies|technical\s+proficiencies)\s*\n([\s\S]*?)(?=\n#\s|\n---|\n$)/i);
  if (skillsMatch) {
    const skillsContent = skillsMatch[1] ?? '';
    
    // Count skills (lines starting with - or bullet points)
    const skillLines = skillsContent.split('\n').filter(l => l.trim().startsWith('-') || l.trim().startsWith('•'));
    const skillCount = skillLines.length;

    if (skillCount >= 5) {
      score += 2;
      details.push(`${skillCount} skills listed`);
    } else {
      issues.push({
        category: 'content',
        severity: 'medium',
        description: 'Too few skills listed',
      });
      suggestions.push('Add more relevant skills (aim for 5-15)');
    }

    // Check for skill categories
    const hasCategories = /^##\s+/m.test(skillsContent);
    if (hasCategories) {
      score += 2;
      details.push('Skills organized by category');
    } else {
      suggestions.push('Organize skills into categories (Languages, Frameworks, Tools)');
    }

    // Check for relevance to job description
    if (skillsContent.length > 50) {
      score += 3;
      details.push('Substantial skills content');
    }
  }

  return {
    name: 'Skills',
    score,
    maxScore: 10,
    passed: score >= 7,
    details: details.join(', '),
  };
}

function scoreExperience(
  text: string,
  issues: ATSIssue[],
  suggestions: string[]
): SectionScore {
  let score = 0;
  const details: string[] = [];

  // Check if experience section exists
  const hasExperience = STANDARD_SECTION_PATTERNS.experience.some(p => p.test(text));
  if (!hasExperience) {
    issues.push({
      category: 'structure',
      severity: 'high',
      description: 'Missing Experience section',
    });
    suggestions.push('Add a Work Experience section');
    return {
      name: 'Experience',
      score: 0,
      maxScore: 10,
      passed: false,
      details: 'Section missing',
    };
  }

  score += 2;
  details.push('Section exists');

  // Extract experience content
  const experienceMatch = text.match(/#\s+(?:work\s+)?(?:experience|professional\s+experience|employment\s+history|career\s+history)\s*\n([\s\S]*?)(?=\n#\s|\n---|\n$)/i);
  if (experienceMatch) {
    const experienceContent = experienceMatch[1] ?? '';
    
    // Check for job entries (## Company — Role pattern)
    const jobEntries = experienceContent.match(/^##\s+.+$/gm) ?? [];
    if (jobEntries.length >= 1) {
      score += 2;
      details.push(`${jobEntries.length} job entries`);
    } else {
      issues.push({
        category: 'formatting',
        severity: 'medium',
        description: 'No job entries found in Experience section',
      });
      suggestions.push('Format experience as: ## Company — Role');
    }

    // Check for dates
    const datePattern = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s*[-–]\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)?\s*\d{4}|(?:Present|Current)/i;
    const hasDates = datePattern.test(experienceContent);
    if (hasDates) {
      score += 2;
      details.push('Dates included');
    } else {
      issues.push({
        category: 'content',
        severity: 'medium',
        description: 'Missing dates in experience',
      });
      suggestions.push('Add dates to each job entry (Mon YYYY – Mon YYYY)');
    }

    // Check for bullet points
    const bulletPoints = experienceContent.match(/^[-•]\s+.+$/gm) ?? [];
    if (bulletPoints.length >= 3) {
      score += 2;
      details.push(`${bulletPoints.length} bullet points`);
    } else {
      suggestions.push('Add more bullet points (3-5 per job)');
    }

    // Check for XYZ format
    const hasXYZ = XYZ_INDICATORS.some(p => p.test(experienceContent));
    if (hasXYZ) {
      score += 2;
      details.push('XYZ format detected');
    } else {
      suggestions.push('Use Google XYZ format for bullet points');
    }
  }

  return {
    name: 'Experience',
    score,
    maxScore: 10,
    passed: score >= 7,
    details: details.join(', '),
  };
}

function scoreEducation(
  text: string,
  issues: ATSIssue[],
  suggestions: string[]
): SectionScore {
  let score = 0;
  const details: string[] = [];

  // Check if education section exists
  const hasEducation = STANDARD_SECTION_PATTERNS.education.some(p => p.test(text));
  if (!hasEducation) {
    issues.push({
      category: 'structure',
      severity: 'high',
      description: 'Missing Education section',
    });
    suggestions.push('Add an Education section');
    return {
      name: 'Education',
      score: 0,
      maxScore: 10,
      passed: false,
      details: 'Section missing',
    };
  }

  score += 4;
  details.push('Section exists');

  // Extract education content
  const educationMatch = text.match(/#\s+education\s*\n([\s\S]*?)(?=\n#\s|\n---|\n$)/i);
  if (educationMatch) {
    const educationContent = educationMatch[1] ?? '';
    
    // Check for degree
    const degreePattern = /(?:Bachelor|Master|Ph\.?D|B\.?S\.?|M\.?S\.?|B\.?A\.?|M\.?A\.?|Associate|Diploma)/i;
    const hasDegree = degreePattern.test(educationContent);
    if (hasDegree) {
      score += 2;
      details.push('Degree mentioned');
    } else {
      suggestions.push('Include your degree (e.g., Bachelor of Science)');
    }

    // Check for institution
    const institutionPattern = /(?:University|College|Institute|School)/i;
    const hasInstitution = institutionPattern.test(educationContent);
    if (hasInstitution) {
      score += 2;
      details.push('Institution mentioned');
    } else {
      suggestions.push('Include your institution name');
    }

    // Check for year
    const yearPattern = /\b(19|20)\d{2}\b/;
    const hasYear = yearPattern.test(educationContent);
    if (hasYear) {
      score += 2;
      details.push('Year included');
    } else {
      suggestions.push('Include graduation year');
    }
  }

  return {
    name: 'Education',
    score,
    maxScore: 10,
    passed: score >= 7,
    details: details.join(', '),
  };
}

function scoreProjects(
  text: string,
  issues: ATSIssue[],
  suggestions: string[]
): SectionScore {
  let score = 0;
  const details: string[] = [];

  // Check if projects section exists
  const hasProjects = STANDARD_SECTION_PATTERNS.projects.some(p => p.test(text));
  if (!hasProjects) {
    // Projects are optional but recommended
    suggestions.push('Consider adding a Projects section');
    return {
      name: 'Projects',
      score: 5, // Neutral score for optional section
      maxScore: 10,
      passed: false,
      details: 'Section missing (optional)',
    };
  }

  score += 5;
  details.push('Section exists');

  // Extract projects content
  const projectsMatch = text.match(/#\s+projects?\s*\n([\s\S]*?)(?=\n#\s|\n---|\n$)/i);
  if (projectsMatch) {
    const projectsContent = projectsMatch[1] ?? '';
    
    // Check for project entries
    const projectEntries = projectsContent.match(/^##\s+.+$/gm) ?? [];
    if (projectEntries.length >= 1) {
      score += 2;
      details.push(`${projectEntries.length} projects listed`);
    }

    // Check for technologies
    const techPattern = /(?:technologies?|tech\s+stack|built\s+with|using)/i;
    const hasTech = techPattern.test(projectsContent);
    if (hasTech) {
      score += 3;
      details.push('Technologies mentioned');
    } else {
      suggestions.push('Mention technologies used in each project');
    }
  }

  return {
    name: 'Projects',
    score,
    maxScore: 10,
    passed: score >= 7,
    details: details.join(', '),
  };
}

function scoreCertifications(
  text: string,
  issues: ATSIssue[],
  suggestions: string[]
): SectionScore {
  let score = 0;
  const details: string[] = [];

  // Check if certifications section exists
  const hasCertifications = STANDARD_SECTION_PATTERNS.certifications.some(p => p.test(text));
  if (!hasCertifications) {
    // Certifications are optional
    suggestions.push('Consider adding relevant certifications');
    return {
      name: 'Certifications',
      score: 5, // Neutral score for optional section
      maxScore: 10,
      passed: false,
      details: 'Section missing (optional)',
    };
  }

  score += 8;
  details.push('Section exists');

  // Extract certifications content
  const certMatch = text.match(/#\s+certifications?\s*\n([\s\S]*?)(?=\n#\s|\n---|\n$)/i);
  if (certMatch) {
    const certContent = certMatch[1] ?? '';
    const certLines = certContent.split('\n').filter(l => l.trim().startsWith('-') || l.trim().startsWith('•'));
    
    if (certLines.length >= 1) {
      score += 2;
      details.push(`${certLines.length} certifications listed`);
    }
  }

  return {
    name: 'Certifications',
    score,
    maxScore: 10,
    passed: score >= 7,
    details: details.join(', '),
  };
}

function scoreFormatting(
  text: string,
  issues: ATSIssue[],
  suggestions: string[]
): SectionScore {
  let score = 0;
  const details: string[] = [];

  // Check for tables (bad for ATS)
  const hasTables = /\|.*\|.*\|/.test(text);
  if (!hasTables) {
    score += 3;
    details.push('No tables detected');
  } else {
    issues.push({
      category: 'formatting',
      severity: 'high',
      description: 'Tables detected — ATS cannot parse them',
    });
    suggestions.push('Remove tables and use bullet points instead');
  }

  // Check for columns (bad for ATS). A genuine column layout shows repeated
  // wide whitespace gaps mid-line across several lines — a lone double space
  // after a period is not a column, so require the pattern on 2+ lines.
  const allLines = text.split('\n');
  const columnGapPattern = /\S\s{3,}\S/;
  const columnLineCount = allLines.filter(l => columnGapPattern.test(l)).length;
  if (columnLineCount < 2) {
    score += 2;
    details.push('Single column layout');
  } else {
    issues.push({
      category: 'formatting',
      severity: 'high',
      description: `Possible multi-column layout (${columnLineCount} lines with wide gaps) — ATS may misparse`,
    });
    suggestions.push('Use a single column layout');
  }

  // Check for standard section headers
  const sectionHeaders = text.match(/^#\s+.+$/gm) ?? [];
  const standardHeaders = sectionHeaders.filter(h => {
    return Object.values(STANDARD_SECTION_PATTERNS).some(patterns =>
      patterns.some(p => p.test(h))
    );
  });

  if (standardHeaders.length >= 3) {
    score += 3;
    details.push('Standard section headers');
  } else {
    issues.push({
      category: 'formatting',
      severity: 'medium',
      description: 'Non-standard section headers',
    });
    suggestions.push('Use standard headers: Summary, Skills, Experience, Education');
  }

  // Check for clean markdown
  const hasCleanMarkdown = !/\*\*\*\*/.test(text) && !/```/.test(text);
  if (hasCleanMarkdown) {
    score += 2;
    details.push('Clean markdown formatting');
  }

  return {
    name: 'Formatting',
    score,
    maxScore: 10,
    passed: score >= 7,
    details: details.join(', '),
  };
}

function scoreKeywords(
  text: string,
  jobDescription: string | undefined,
  issues: ATSIssue[],
  suggestions: string[]
): SectionScore {
  let score = 0;
  const details: string[] = [];

  if (!jobDescription) {
    // No job description provided — neutral score
    return {
      name: 'Keywords',
      score: 5,
      maxScore: 10,
      passed: false,
      details: 'No job description provided for keyword matching',
    };
  }

  // Extract keywords from job description
  const jdWords = jobDescription
    .toLowerCase()
    .split(/\W+/)
    .filter(w => w.length > 3);

  // Count unique keywords found in resume
  const resumeLower = text.toLowerCase();
  const foundKeywords = new Set<string>();
  
  for (const word of jdWords) {
    if (resumeLower.includes(word)) {
      foundKeywords.add(word);
    }
  }

  const matchRate = jdWords.length > 0 ? foundKeywords.size / jdWords.length : 0;

  if (matchRate >= 0.6) {
    score += 8;
    details.push(`${Math.round(matchRate * 100)}% keyword match`);
  } else if (matchRate >= 0.3) {
    score += 5;
    details.push(`${Math.round(matchRate * 100)}% keyword match`);
    suggestions.push('Add more keywords from the job description');
  } else {
    score += 2;
    details.push(`${Math.round(matchRate * 100)}% keyword match`);
    suggestions.push('Significantly more keywords from the job description needed');
    issues.push({
      category: 'keywords',
      severity: 'high',
      description: 'Low keyword match with job description',
    });
  }

  // Check for missing high-priority keywords
  const missingKeywords = jdWords.filter(w => !resumeLower.includes(w)).slice(0, 5);
  if (missingKeywords.length > 0) {
    suggestions.push(`Consider adding: ${missingKeywords.join(', ')}`);
  }

  return {
    name: 'Keywords',
    score,
    maxScore: 10,
    passed: score >= 7,
    details: details.join(', '),
  };
}

function scoreLength(
  text: string,
  issues: ATSIssue[],
  suggestions: string[]
): SectionScore {
  let score = 0;
  const details: string[] = [];

  const charCount = text.length;
  const wordCount = text.split(/\s+/).filter(w => w).length;

  if (charCount >= LENGTH_THRESHOLDS.optimal.min && charCount <= LENGTH_THRESHOLDS.optimal.max) {
    score += 10;
    details.push(`Optimal length (${charCount} chars, ~${Math.round(charCount / 3000)} pages)`);
  } else if (charCount >= LENGTH_THRESHOLDS.acceptable.min && charCount <= LENGTH_THRESHOLDS.acceptable.max) {
    score += 7;
    details.push(`Acceptable length (${charCount} chars)`);
    if (charCount > LENGTH_THRESHOLDS.optimal.max) {
      suggestions.push('Consider trimming to fit one page');
    }
  } else if (charCount < LENGTH_THRESHOLDS.acceptable.min) {
    score += 4;
    details.push(`Too short (${charCount} chars)`);
    suggestions.push('Add more content to reach at least 1000 characters');
    issues.push({
      category: 'content',
      severity: 'medium',
      description: 'Resume is too short',
    });
  } else {
    score += 3;
    details.push(`Too long (${charCount} chars)`);
    suggestions.push('Trim content to fit one page (max 5000 characters)');
    issues.push({
      category: 'content',
      severity: 'medium',
      description: 'Resume is too long',
    });
  }

  return {
    name: 'Length',
    score,
    maxScore: 10,
    passed: score >= 7,
    details: details.join(', '),
  };
}

// ── Helpers ────────────────────────────────────────────────────

function determineGrade(percentage: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (percentage >= 90) return 'A';
  if (percentage >= 80) return 'B';
  if (percentage >= 70) return 'C';
  if (percentage >= 60) return 'D';
  return 'F';
}

// ── Exports ────────────────────────────────────────────────────

export { scoreResume };
export type { ATSScoreResult, SectionScore, ATSIssue };
