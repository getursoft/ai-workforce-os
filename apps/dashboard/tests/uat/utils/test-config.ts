/** A fresh, unique test user/org — call once per spec file (not once per process). Node only evaluates
 * this module once per worker, so a static `testUser` object would be silently SHARED across every spec
 * file that worker runs, and the second file's registration would 409 against the first file's account. */
export function createTestUser() {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    email: `uat-test-${unique}@example.com`,
    password: "StrongPassword@123",
    firstName: "UAT",
    lastName: "Tester",
    organizationName: `UAT Test Org ${unique}`
  };
}

export const TEST_CONFIG = {
  baseURL: "http://localhost:3000",
  apiURL: "http://localhost:4000",
  timeouts: {
    navigation: 30000,
    action: 15000,
    api: 30000,
    batchProcessing: 60000
  },
  jobs: {
    jobA: {
      title: "Senior Azure Data Engineer",
      description: `We are looking for a Senior Azure Data Engineer to build and operate our Azure data platform. The ideal candidate will have deep expertise in Azure Data Factory, Azure Databricks, Python, PySpark, SQL, and Azure Data Lake Storage Gen2 (ADLS Gen2). You will design, develop, and maintain scalable data pipelines, optimize data processing workflows, and ensure data quality across the organization.

Key Responsibilities:
- Design and implement end-to-end data pipelines using Azure Data Factory and Azure Databricks
- Develop and optimize PySpark jobs for large-scale data processing
- Manage and optimize ADLS Gen2 storage architecture
- Implement CI/CD pipelines for data engineering workflows
- Collaborate with data scientists and analysts to deliver high-quality data products
- Monitor and troubleshoot data pipeline performance
- Implement data governance and quality frameworks

Required Qualifications:
- 6+ years of experience in data engineering
- Expert-level knowledge of Azure Data Factory
- Expert-level knowledge of Azure Databricks
- Strong proficiency in Python and PySpark
- Deep understanding of SQL and relational databases
- Hands-on experience with Azure Data Lake Storage Gen2 (ADLS Gen2)
- Experience with CI/CD tools (Azure DevOps, GitHub Actions)
- Strong problem-solving and communication skills

Preferred Qualifications:
- Experience with Snowflake
- Knowledge of Delta Lake
- Experience with Azure Event Hubs
- Power BI for data visualization
- Azure certifications (DP-203, DP-100)`,
      department: "Engineering",
      location: "Bangalore, India",
      minExperienceYears: 6,
      maxExperienceYears: 12,
      mandatorySkills: [
        "Azure Data Factory",
        "Azure Databricks",
        "Python",
        "PySpark",
        "SQL",
        "Azure Data Lake Storage Gen2"
      ],
      preferredSkills: [
        "Snowflake",
        "Delta Lake",
        "Azure Event Hubs",
        "CI/CD",
        "Power BI"
      ],
      certifications: ["DP-203", "DP-100"],
      scoringConfig: {
        mandatorySkillWeight: 35,
        preferredSkillWeight: 15,
        experienceWeight: 25,
        projectExperienceWeight: 15,
        certificationWeight: 10
      },
      numberOfOpenings: 2
    },
    jobB: {
      title: "Cloud Solution Architect",
      description: `We are seeking a Cloud Solution Architect to design and implement enterprise-grade Azure architectures. You will be responsible for defining cloud strategy, designing scalable and secure solutions, and guiding teams through cloud adoption.

Key Responsibilities:
- Design enterprise Azure architectures covering networking, identity, security, availability, and disaster recovery
- Define cloud governance frameworks and best practices
- Lead cloud migration and modernization initiatives
- Collaborate with stakeholders to translate business requirements into technical architectures
- Implement FinOps practices for cost optimization
- Establish security baselines and compliance frameworks
- Mentor engineering teams on cloud-native patterns

Required Qualifications:
- 8+ years of experience in cloud architecture
- Deep expertise in Azure architecture (networking, identity, security, availability, DR)
- Strong understanding of Azure governance and compliance
- Experience with enterprise integration patterns
- Proven track record of designing highly available and disaster-resilient systems
- Expert knowledge of Azure security services (Defender, Sentinel, Key Vault, Entra ID)
- Experience with infrastructure as code

Preferred Qualifications:
- Kubernetes (AKS) experience
- Terraform for infrastructure as code
- FinOps certification/practices
- Enterprise integration experience (API Management, Logic Apps, Service Bus)
- TOGAF or similar architecture framework certification`,
      department: "Architecture",
      location: "Hyderabad, India",
      minExperienceYears: 8,
      maxExperienceYears: 15,
      mandatorySkills: [
        "Azure Architecture",
        "Azure Networking",
        "Azure Identity",
        "Azure Security",
        "High Availability",
        "Disaster Recovery",
        "Azure Governance"
      ],
      preferredSkills: [
        "Kubernetes",
        "Terraform",
        "FinOps",
        "Enterprise Integration"
      ],
      certifications: ["AZ-305", "AZ-500"],
      scoringConfig: {
        mandatorySkillWeight: 40,
        preferredSkillWeight: 10,
        experienceWeight: 25,
        projectExperienceWeight: 15,
        certificationWeight: 10
      },
      numberOfOpenings: 1
    },
    jobC: {
      title: "AI/ML Engineer",
      description: `We are looking for an AI/ML Engineer to build and deploy machine learning solutions using LLMs, RAG, and vector databases. You will work on cutting-edge AI applications and productionize ML models.

Key Responsibilities:
- Design and implement ML pipelines for training, evaluation, and deployment
- Build RAG systems using LLMs, embeddings, and vector databases
- Optimize model performance and implement evaluation frameworks
- Collaborate with product teams to integrate AI capabilities
- Implement MLOps practices for model lifecycle management
- Research and experiment with new AI/ML techniques
- Ensure responsible AI practices and model governance

Required Qualifications:
- 4+ years of experience in ML engineering
- Strong proficiency in Python
- Deep understanding of machine learning algorithms and techniques
- Hands-on experience with LLMs and prompt engineering
- Experience with RAG (Retrieval-Augmented Generation) architectures
- Knowledge of embeddings and vector databases (Pinecone, Weaviate, Chroma, etc.)
- Experience with ML frameworks (PyTorch, TensorFlow, Hugging Face)

Preferred Qualifications:
- Azure OpenAI Service experience
- LangChain/LlamaIndex experience
- ML model evaluation frameworks (DeepEval, Ragas, etc.)
- MLOps experience (MLflow, Kubeflow, Azure ML)
- Publications or contributions to AI/ML community`,
      department: "AI Research",
      location: "Pune, India",
      minExperienceYears: 4,
      maxExperienceYears: 10,
      mandatorySkills: [
        "Python",
        "Machine Learning",
        "LLMs",
        "RAG",
        "Embeddings",
        "Vector Databases"
      ],
      preferredSkills: [
        "Azure OpenAI",
        "LangChain",
        "Evaluation Frameworks",
        "MLOps"
      ],
      certifications: ["AI-102", "DP-100"],
      scoringConfig: {
        mandatorySkillWeight: 35,
        preferredSkillWeight: 15,
        experienceWeight: 20,
        projectExperienceWeight: 20,
        certificationWeight: 10
      },
      numberOfOpenings: 3
    }
  }
} as const;