# InterviewIQ.ai — Project Documentation

AI-powered mock interview platform. Users pick a role, experience level, and interview mode (HR / Technical), optionally upload a resume, and go through a timed 5-question AI-generated interview. Each answer is scored live by an LLM across confidence, communication, and correctness, and a final report is generated at the end. A credit-based system (topped up via Razorpay) gates how many interviews a user can run.

---

## 1. Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Redux Toolkit, React Router v7, Tailwind CSS v4, Framer Motion (`motion`), Recharts, React Circular Progressbar, jsPDF + autotable |
| Backend | Node.js, Express 5, Mongoose (MongoDB) |
| Auth | Firebase Auth (Google Sign-In) → custom JWT issued by the backend, stored as an HTTP cookie |
| AI | OpenRouter API (`openai/gpt-4o-mini`) for resume parsing, question generation, and answer scoring |
| Payments | Razorpay (order creation + signature verification) |
| File handling | Multer (resume upload), `pdfjs-dist` (PDF text extraction) |
| Build tools | Vite (client), Nodemon (server dev) |

---

## 2. High-Level Architecture

```mermaid
flowchart TB
    subgraph Client["React Client (Vite)"]
        UI["Pages: Home, Auth, InterviewPage,\nInterviewHistory, Pricing, InterviewReport"]
        Redux["Redux Store\n(userSlice)"]
        FirebaseSDK["Firebase Auth SDK\n(Google provider)"]
    end

    subgraph Server["Express Server"]
        Routes["Routes\n/api/auth /api/user\n/api/interview /api/payment"]
        MW["Middlewares\nisAuth (JWT) · multer (upload)"]
        Ctrl["Controllers\nauth · user · interview · payment"]
        Svc["Services\nopenRouter.service.js\nrazorpay.service.js"]
    end

    subgraph External["External Services"]
        FB["Firebase Authentication"]
        OR["OpenRouter API\n(gpt-4o-mini)"]
        RZP["Razorpay API"]
        Mongo[("MongoDB\nUser · Interview · Payment")]
    end

    UI <--> Redux
    UI --> FirebaseSDK
    FirebaseSDK <--> FB
    UI -- "axios (withCredentials)" --> Routes
    Routes --> MW --> Ctrl
    Ctrl --> Svc
    Ctrl <--> Mongo
    Svc --> OR
    Svc --> RZP
```

---

## 3. Folder Structure

```
3.interviewIQ/
├── server/
│   ├── config/
│   │   ├── connectDb.js         # Mongoose connection
│   │   └── token.js             # JWT signing helper
│   ├── controllers/
│   │   ├── auth.controller.js       # googleAuth, logOut
│   │   ├── user.controller.js       # getCurrentUser
│   │   ├── interview.controller.js  # resume parse, question gen, scoring, reports
│   │   └── payment.controller.js    # createOrder, verifyPayment
│   ├── middlewares/
│   │   ├── isAuth.js             # JWT cookie verification
│   │   └── multer.js             # resume upload handling
│   ├── models/
│   │   ├── user.model.js         # name, email, credits
│   │   ├── interview.model.js    # role, mode, questions[], finalScore, status
│   │   └── payment.model.js      # razorpay order/payment tracking
│   ├── routes/
│   │   ├── auth.route.js
│   │   ├── user.route.js
│   │   ├── interview.route.js
│   │   └── payment.route.js
│   ├── services/
│   │   ├── openRouter.service.js # askAi() wrapper around OpenRouter chat completions
│   │   └── razorpay.service.js   # Razorpay instance
│   └── index.js                  # app bootstrap, CORS, cookie-parser
│
└── client/
    └── src/
        ├── pages/
        │   ├── Home.jsx
        │   ├── Auth.jsx
        │   ├── InterviewPage.jsx      # hosts the 3-step interview wizard
        │   ├── InterviewHistory.jsx
        │   ├── InterviewReport.jsx
        │   └── Pricing.jsx
        ├── components/
        │   ├── Step1SetUp.jsx     # role/experience/mode + resume upload
        │   ├── Step2Interview.jsx # question-by-question flow, timer, recording
        │   ├── Step3Report.jsx    # scorecard, charts, PDF export
        │   ├── Navbar.jsx, Footer.jsx, Timer.jsx, AuthModel.jsx
        ├── redux/
        │   ├── store.js
        │   └── userSlice.js       # userData state
        └── utils/
            └── firebase.js        # Firebase app + Google provider init
```

---

## 4. Data Models

```mermaid
erDiagram
    USER ||--o{ INTERVIEW : owns
    USER ||--o{ PAYMENT : makes

    USER {
        ObjectId _id
        string name
        string email UK
        number credits "default 100"
        date createdAt
    }

    INTERVIEW {
        ObjectId _id
        ObjectId userId FK
        string role
        string experience
        string mode "HR or Technical"
        string resumeText
        Question[] questions
        number finalScore
        string status "Incompleted or completed"
    }

    QUESTION {
        string question
        string difficulty "easy/medium/hard"
        number timeLimit "60/90/120 sec"
        string answer
        string feedback
        number score
        number confidence
        number communication
        number correctness
    }

    PAYMENT {
        ObjectId _id
        ObjectId userId FK
        string planId
        number amount
        number credits
        string razorpayOrderId
        string razorpayPaymentId
        string status "created/paid/failed"
    }

    INTERVIEW ||--o{ QUESTION : contains
```

---

## 5. Authentication Flow

Google Sign-In happens client-side via Firebase; the backend never talks to Firebase directly. Firebase only proves identity — the app then mints its **own** JWT so subsequent API calls don't depend on Firebase tokens.

```mermaid
sequenceDiagram
    participant U as User
    participant C as React Client
    participant F as Firebase Auth
    participant S as Express Server
    participant DB as MongoDB

    U->>C: Click "Continue with Google"
    C->>F: signInWithPopup(GoogleProvider)
    F-->>C: Firebase user (name, email)
    C->>S: POST /api/auth/google { name, email }
    S->>DB: findOne(email) or create User (credits: 100)
    DB-->>S: user document
    S->>S: genToken(user._id) → JWT
    S-->>C: Set-Cookie: token (httpOnly, 7d) + user JSON
    C->>C: dispatch(setUserData(user))

    Note over C,S: Every later request
    C->>S: axios call (withCredentials: true)
    S->>S: isAuth middleware: jwt.verify(cookie)
    S-->>C: 200 (authorized) or 400 (no/invalid token)
```

---

## 6. Interview Flow (core feature)

The interview UI is a 3-step wizard: **Setup → Live Interview → Report**. Each step maps to backend calls that spend credits and call the AI service.

```mermaid
sequenceDiagram
    participant U as User
    participant Step1 as Step1SetUp
    participant Step2 as Step2Interview
    participant Step3 as Step3Report
    participant S as Server
    participant AI as OpenRouter (gpt-4o-mini)
    participant DB as MongoDB

    U->>Step1: Select role, experience, mode
    opt Resume uploaded
        Step1->>S: POST /interview/resume (multipart, resume.pdf)
        S->>S: pdfjs-dist extracts raw text
        S->>AI: "Extract role/experience/projects/skills as JSON"
        AI-->>S: structured JSON
        S-->>Step1: role, experience, projects, skills, resumeText
    end
    Step1->>S: POST /interview/generate-questions
    S->>DB: check user.credits >= 50
    S->>AI: "Generate 5 questions (easy→hard) for this profile"
    AI-->>S: 5 plain-text questions
    S->>DB: create Interview doc (questions[], timeLimits 60/60/90/90/120)
    S->>DB: user.credits -= 50
    S-->>Step1: interviewId + questions[]

    loop For each of 5 questions
        Step2->>Step2: show question + start Timer(timeLimit)
        U->>Step2: speak/type answer (or timeout)
        Step2->>S: POST /interview/submit-answer {interviewId, questionIndex, answer, timeTaken}
        alt no answer or time exceeded
            S->>DB: score = 0, feedback = "not answered / time exceeded"
        else valid answer
            S->>AI: "Score confidence/communication/correctness (0-10) + 10-15 word feedback"
            AI-->>S: {confidence, communication, correctness, finalScore, feedback}
            S->>DB: save scored question
        end
        S-->>Step2: feedback text
    end

    Step2->>S: POST /interview/finish {interviewId}
    S->>DB: average all question scores → finalScore, status = "completed"
    S-->>Step3: finalScore, confidence, communication, correctness, questionWiseScore[]
    Step3->>Step3: render charts (Recharts) + circular progress + jsPDF export
```

---

## 7. Payment / Credits Flow

Interviews cost 50 credits each (new users start with 100). Running low triggers the Pricing page, backed by Razorpay.

```mermaid
sequenceDiagram
    participant U as User
    participant C as Pricing Page
    participant S as Server
    participant RZP as Razorpay
    participant DB as MongoDB

    U->>C: Select a credit plan
    C->>S: POST /payment/order {planId, amount, credits}
    S->>RZP: orders.create({amount*100, currency: INR})
    RZP-->>S: order object
    S->>DB: Payment.create(status: "created")
    S-->>C: order details
    C->>RZP: Open Razorpay Checkout widget
    U->>RZP: Completes payment
    RZP-->>C: razorpay_order_id, payment_id, signature
    C->>S: POST /payment/verify {order_id, payment_id, signature}
    S->>S: HMAC-SHA256(order_id + "|" + payment_id, KEY_SECRET)
    alt signature valid
        S->>DB: Payment.status = "paid"
        S->>DB: User.credits += payment.credits
        S-->>C: { success: true, user }
    else invalid signature
        S-->>C: 400 Invalid payment signature
    end
```

---

## 8. API Reference

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/google` | — | Create/fetch user by email, issue JWT cookie |
| GET | `/api/auth/logout` | — | Clear JWT cookie |
| GET | `/api/user/current-user` | ✅ | Fetch logged-in user's profile |
| POST | `/api/interview/resume` | ✅ | Upload resume PDF, extract & AI-parse structured data |
| POST | `/api/interview/generate-questions` | ✅ | Deduct 50 credits, generate 5 AI questions, create Interview |
| POST | `/api/interview/submit-answer` | ✅ | Score one answer via AI (or auto-zero if skipped/timed out) |
| POST | `/api/interview/finish` | ✅ | Average scores, mark interview completed |
| GET | `/api/interview/get-interview` | ✅ | List user's past interviews (summary fields) |
| GET | `/api/interview/report/:id` | ✅ | Full question-wise report for one interview |
| POST | `/api/payment/order` | ✅ | Create Razorpay order + pending Payment record |
| POST | `/api/payment/verify` | ✅ | Verify signature, mark paid, credit user |

---

## 9. Notable Implementation Details

- **Credit gating**: `generateQuestion` rejects with 400 if `user.credits < 50` before ever calling the AI — avoids spending AI calls on users who can't afford them.
- **Anti-cheat scoring**: if `timeTaken > question.timeLimit`, the answer is discarded and auto-scored 0 server-side, regardless of what the client sends as `answer` — the time check happens on the trusted server clock.
- **Difficulty ramp**: questions are hard-coded to escalate — indices `[easy, easy, medium, medium, hard]` with time limits `[60, 60, 90, 90, 120]` seconds.
- **Resume parsing pipeline**: PDF → `pdfjs-dist` raw text extraction → whitespace normalization → single AI call constrained to return strict JSON (`role`, `experience`, `projects`, `skills`) → merged into the question-generation prompt for personalization.
- **Stateless AI scoring**: each answer is scored independently and immediately (not batched at the end), so users get instant feedback per question, then `finishInterview` simply aggregates the stored per-question numbers.
- **Security**: JWT stored as an httpOnly cookie (not localStorage) with a 7-day expiry; Razorpay payments are verified server-side via HMAC signature comparison before any credits are granted — the client is never trusted to say "payment succeeded."

---

## 10. Possible Next Steps / Improvement Ideas
- Add refresh-token rotation alongside the 7-day JWT for better session security.
- Move resume file storage off local disk (currently written via Multer then deleted after parsing) to short-lived cloud storage if scaling beyond a single server instance.
- Add rate limiting on `/generate-questions` and `/submit-answer` to control OpenRouter API cost exposure.
- Cache/report webhook from Razorpay as a fallback to the client-driven `/verify` call, in case the user closes the tab mid-payment.
