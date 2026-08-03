# Loop GPT — Agentic Chat Portal

A flagship, agentic chat portal (Claude.ai / Manus-class) built with Next.js, Node.js, and PostgreSQL, with the primary model served by a **Hugging Face Inference Endpoint**.

> 🧠 **New: agentic layer.** Real tool-using agent with streaming, deep research
> (web search + cited synthesis), native vision, image generation, and document
> generation (PDF/DOCX/XLSX/PPTX) — plus MCP servers, connectors, skills, and
> plugins. See **[docs/AGENT_PORTAL.md](docs/AGENT_PORTAL.md)** for setup and
> architecture. Configure your endpoint via `HF_ENDPOINT_URL` / `HF_TOKEN`.

## 🚀 Features

- **Modern ChatGPT-like UI** - Clean, responsive interface with dark mode
- **Real-time Chat** - Stream responses from AI models
- **AI Image Generation** - Generate images from text using FLUX/SD models
- **Vision Analysis** - Analyze and describe uploaded images
- **Vision Q&A** - Ask questions about images using AI vision models
- **Conversation Management** - Create, save, and manage multiple conversations
- **User Authentication** - Secure user accounts and session management
- **Smart Tool Detection** - Automatically detects the right tool for your request
- **Auto-deployment** - Automated CI/CD with Vercel (frontend) and Render (backend)

## 📁 Project Structure

```
Loop_GPT/
├── frontend/          # Next.js frontend application
├── backend/           # Node.js/Express backend API
├── database/          # Database migrations and schema
└── docs/              # Documentation
```

## 🛠️ Tech Stack

### Frontend
- **Next.js 14** - React framework with App Router
- **TypeScript** - Type safety
- **Tailwind CSS** - Styling
- **shadcn/ui** - UI components
- **React Query** - Data fetching and caching

### Backend
- **Node.js** - Runtime environment
- **Express** - Web framework
- **PostgreSQL** - Database
- **Prisma** - ORM
- **JWT** - Authentication
- **OpenAI API** - AI integration

## 🚀 Getting Started

### Prerequisites
- Node.js 18+
- PostgreSQL 14+
- npm or yarn

### Installation

1. Clone the repository
```bash
git clone <repository-url>
cd Loop_GPT
```

2. Install dependencies
```bash
# Frontend
cd frontend
npm install

# Backend
cd ../backend
npm install
```

3. Set up environment variables
```bash
# Backend .env
DATABASE_URL=postgresql://user:password@localhost:5432/loopgpt
JWT_SECRET=your-secret-key
OPENAI_API_KEY=your-openai-key
PORT=3001

# Frontend .env.local
NEXT_PUBLIC_API_URL=http://localhost:3001
```

4. Run database migrations
```bash
cd backend
npx prisma migrate dev
```

5. Start development servers
```bash
# Backend (terminal 1)
cd backend
npm run dev

# Frontend (terminal 2)
cd frontend
npm run dev
```

## 📦 Deployment

### Frontend (Vercel)
- Automatically deploys on push to main branch
- Configured via `vercel.json`
- See [Deployment Guide](./docs/DEPLOYMENT.md) for detailed instructions

### Backend (Render)
- Automatically deploys on push to main branch
- Configured via `render.yaml`
- PostgreSQL database included in deployment config

For detailed deployment instructions, see [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)

## 📚 Documentation

- [Deployment Guide](./docs/DEPLOYMENT.md) - Complete deployment instructions
- [Backend & Database Summary](./docs/BACKEND_DATABASE_SUMMARY.md) - Comprehensive guide for backend developers
- [Advanced Features Guide](./docs/ADVANCED_FEATURES.md) - Image generation, vision analysis, and more
- [Contributing Guide](./CONTRIBUTING.md) - How to contribute to the project

## 🔑 Environment Variables

### Backend
- `DATABASE_URL` - PostgreSQL connection string
- `JWT_SECRET` - Secret key for JWT tokens
- `OPENAI_API_KEY` - Your OpenAI API key
- `OPENAI_MODEL` - Model to use (default: gpt-3.5-turbo)
- `IMAGE_API_URL` - Image generation API URL (default: http://localhost:8081)
- `PORT` - Server port (default: 3001)
- `FRONTEND_URL` - Frontend URL for CORS

### Frontend
- `NEXT_PUBLIC_API_URL` - Backend API URL

## 🧪 Development

### Running Tests
```bash
# Backend
cd backend
npm test

# Frontend
cd frontend
npm test
```

### Database Management
```bash
cd backend
npx prisma studio  # Open database GUI
npx prisma migrate dev  # Create new migration
```

## 🤝 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

## 📝 License

MIT License - see [LICENSE](./LICENSE) file for details

## 🙏 Acknowledgments

- Inspired by ChatGPT's user interface
- Built with modern web technologies
- Uses OpenAI API for AI capabilities

