# harbor-infrastructure

Deploys Harbor container registry with Keycloak OIDC authentication on Kubernetes.

## Purpose

This stack deploys the Harbor container registry using Helm and configures OIDC authentication via Keycloak. It creates the Harbor Keycloak realm, OIDC client, and Harbor projects but delegates user management to the keycloak-config stack.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│ Harbor Authentication & Registry - Multi-Stack Architecture │
└─────────────────────────────────────────────────────────────┘

1. keycloak (prod)
   └─> Deploys Keycloak server on Kubernetes

2. keycloak-config (dev)
   └─> Creates users and groups in Harbor realm

3. harbor-infrastructure (prod) ← THIS STACK
   └─> Deploys Harbor registry via Helm
   └─> Creates Harbor Keycloak realm
   └─> Creates OIDC client configuration
   └─> Creates Harbor projects
   └─> Configures OIDC authentication

4. harbor-permissions (prod)
   └─> Manages Harbor project permissions
   └─> Creates robot accounts for CI/CD
```

## Deployment Order

**IMPORTANT:** Deploy in this exact order:

```bash
# 1. Deploy Keycloak server (if not already deployed)
cd ../keycloak
pulumi up

# 2. Deploy this stack (creates Harbor + realm + OIDC client)
cd ../harbor-infrastructure
pulumi up

# 3. Deploy keycloak-config (creates users)
cd ../keycloak-config
pulumi up

# 4. Deploy harbor-permissions (assigns permissions)
cd ../harbor-permissions
pulumi up
```

## What This Stack Manages

- ✅ **Harbor Deployment** via Helm chart
- ✅ **Harbor Keycloak Realm** (Harbor)
- ✅ **OIDC Client** for Harbor in Keycloak
- ✅ **Client Scopes** and protocol mappers
- ✅ **Harbor Projects** (realestateanalyzor, proxy-cache, aiaugmentedsoftwaredev)
- ✅ **Harbor OIDC Configuration** (auth mode, endpoints, scopes)
- ✅ **S3 Storage** via Ceph ObjectBucketClaim
- ✅ **PostgreSQL Database** for Harbor metadata

## What This Stack Does NOT Manage

- ❌ Keycloak users (managed by keycloak-config)
- ❌ Keycloak groups (managed by keycloak-config)
- ❌ Harbor project member assignments (managed by harbor-permissions)
- ❌ Robot accounts (managed by harbor-permissions)

## Stack References

This stack depends on:
- `egulatee/keycloak/prod` - Keycloak admin credentials
- `egulatee/kubeconfig/prod` - Kubernetes access
- `egulatee/rook-ceph/dev` - S3 storage credentials
- `egulatee/traefik-ingress/prod` - Ingress configuration

## Configuration

Harbor is deployed with:
- **URL:** https://harbor.egyrllc.com
- **Auth Mode:** OIDC (Keycloak)
- **OIDC Endpoint:** https://keycloak.egyrllc.com/realms/Harbor
- **Storage:** Ceph S3 via ObjectBucketClaim
- **Database:** PostgreSQL (deployed with Harbor Helm chart)

## Outputs

```bash
# View all outputs
pulumi stack output

# Get specific outputs
pulumi stack output harborUrl                      # https://harbor.egyrllc.com
pulumi stack output harborAdminPasswordExport --show-secrets  # Admin password
pulumi stack output oidcClientId                   # harbor
pulumi stack output oidcClientSecret --show-secrets # OIDC client secret
```

## Harbor Projects

This stack creates three Harbor projects:

1. **realestateanalyzor** - Real estate analyzer application images
2. **proxy-cache** - DockerHub proxy cache (linked to DockerHub registry)
3. **aiaugmentedsoftwaredev** - AI-augmented software development images

## OIDC Configuration

Harbor is configured with:
- **OIDC Name:** Keycloak
- **Client ID:** harbor
- **Endpoint:** https://keycloak.egyrllc.com/realms/Harbor
- **Scopes:** `openid,profile,email,offline_access`
- **User Claim:** preferred_username
- **Auto Onboard:** Enabled (users auto-created on first login)
- **Verify Cert:** Enabled

## Login Methods

**OIDC Login (Recommended):**
- URL: https://harbor.egyrllc.com/c/oidc/login
- Uses Keycloak credentials from keycloak-config stack

**Admin Login (Local):**
- URL: https://harbor.egyrllc.com
- Username: `admin`
- Password: `pulumi stack output harborAdminPasswordExport --show-secrets`

## Troubleshooting

**Issue:** Harbor pods not starting
```bash
kubectl get pods -n harbor
kubectl describe pod -n harbor <pod-name>
kubectl logs -n harbor <pod-name>
```

**Issue:** OIDC login not working
```bash
# Check OIDC endpoint
curl -k https://keycloak.egyrllc.com/realms/Harbor/.well-known/openid-configuration

# Check Harbor OIDC config
kubectl logs -n harbor -l component=core | grep -i oidc

# Verify users exist in keycloak-config stack
cd ../keycloak-config && pulumi stack
```

**Issue:** S3 storage not working
```bash
# Check ObjectBucketClaim
kubectl get obc -n harbor harbor-registry-bucket

# Check bucket credentials secret
kubectl get secret -n harbor harbor-registry-bucket
```

**Issue:** Pulumi state drift detected
```bash
# Refresh state to detect differences
pulumi refresh

# Common causes:
# - Keycloak was restarted and realm was deleted
# - Harbor Helm chart was manually modified
# - Resources deleted outside of Pulumi
```

## Updating Harbor

```bash
# Update Helm chart version in harbor.ts
# Then run:
pulumi up

# Harbor will perform rolling update with zero downtime
```

## Related Stacks

- **keycloak** - Keycloak server deployment
- **keycloak-config** - Harbor users & groups
- **harbor-permissions** - Project permissions + robot accounts
