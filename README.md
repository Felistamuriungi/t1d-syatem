# MoH 100 Type 1 Diabetes (T1D) PWA Triage & Referral System

A secure, multi-role Progressive Web Application (PWA) designed to digitize the Ministry of Health (MoH 100) screening and referral workflow for Type 1 Diabetes management.

## 🚀 Key Features

* **Multi-Role RBAC:** Dedicated landing pages and access control for **CHP** (Community Health Promoters), **HRIO** (Health Records Officers), and **HCP** (Healthcare Providers).
* **Clinical Decision Support System (CDSS):** Built-in algorithmic engine evaluating patient symptoms and blood sugar levels (RBS) to assign instant risk profiles.
* **Real-time Notifications:** Driven by **Socket.io** to send immediate referral alerts to facility dashboards upon high-risk triage submission.
* **JWT Authentication:** Session tokens for user role validation and route protection.

## 🛠️ Tech Stack

* **Backend:** Node.js, Express.js
* **Database:** PostgreSQL (`t1d_screening_db`)
* **Real-Time Engine:** Socket.io
* **Frontend:** HTML5, CSS3, JavaScript (ES6+), PWA architecture

## 📁 Database Schema

The database relies on 6 relational tables:
* `roles` - System access levels (CHP, HRIO, HCP)
* `facilities` - Healthcare facilities and levels
* `users` - Authenticated staff accounts
* `patients` - Screened individual demographic records
* `triage_logs` - Field screening records and CDSS risk classifications
* `referral_tickets` - Active care facility referral status

## ⚙️ Local Setup Instructions

1. **Clone the Repository:**
   ```bash
   git clone [https://github.com/Felistamuriungi/t1d-syatem.git](https://github.com/Felistamuriungi/t1d-syatem.git)
   cd t1d-syatem