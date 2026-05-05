# RolloMap PRD

## Overview
RolloMap is a personal relationship intelligence system that builds a private, evidence-backed map of a user's network. It ingests personal data sources (email, documents, notes) and allows users to query their network with AI.

## Core Value
- Memory augmentation for relationships
- Context recall before interactions
- Identifying relevant people for ideas/opportunities

## Principles
- Private by default
- Evidence-based outputs
- User-owned data
- No cross-user data aggregation

## Target User
- Professionals with large networks
- Founders, operators, investors
- People who rely on relationships

## Core Features

### 1. Data Ingestion
- Gmail integration
- Google Docs integration
- Calendar integration
- Manual note entry

### 2. Entity Resolution
- Identify unique people across sources
- Merge identities (email, name, notes)

### 3. Person Profile
Each person includes:
- Name
- Contact info
- Interaction timeline
- Topics of interest
- Relationship strength
- Last interaction
- Evidence references

### 4. Query System
- "Who would be interested in X?"
- "Brief me on [Person]"
- "Who have I not talked to in a while?"

### 5. Evidence Layer
All outputs must include:
- Source reference
- Timestamp
- Context snippet

## Architecture

### Components
- Connectors (Gmail, Docs, Calendar)
- Processing pipeline (NLP + entity resolution)
- Storage (Relational DB + Vector DB)
- API / MCP server
- UI (Web + Mobile)

## Success Metrics
- Daily active usage
- Query success rate
- User trust (low correction rate)

## Future Vision
- Full Agent OS integration
- Cross-tool intelligence layer
- Personal data portability
