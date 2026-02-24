# Nginx config for TwynBook

## 405 Method Not Allowed (signup / login)

If **POST** requests to `/api/auth/signup` or `/api/auth/login` return **405 Method Not Allowed**, Nginx is likely sending API traffic to a handler that only supports GET (e.g. static files or SPA fallback). Fix: proxy `/api/` to the backend **before** any catch-all `location /`.

Use a dedicated `location /api/` block and keep it **above** `location /`:

```nginx
# API: must come BEFORE location / so POST/PUT/DELETE reach the backend
location /api/ {
    proxy_pass http://127.0.0.1:8087;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_connect_timeout 600s;
    proxy_send_timeout 600s;
    proxy_read_timeout 600s;
    client_max_body_size 25M;
}

location / {
    proxy_pass http://127.0.0.1:8087;
    # ... same headers and timeouts ...
}
```

Then run `sudo nginx -t && sudo systemctl reload nginx`.

### Apply on the server (fix 405)

1. **SSH into the server** (e.g. the host for `twynbook.4th-ir.com`).
2. **Open the Nginx site config**, e.g.:
   ```bash
   sudo nano /etc/nginx/sites-available/twynbook
   ```
   or wherever `twynbook.4th-ir.com` is defined.
3. **Ensure you have a `location /api/` block** that proxies to your backend (e.g. `http://127.0.0.1:8087`), and that this block appears **above** any `location /` block. If you only have `location / { ... }`, add the `/api/` block before it.
4. **Test and reload:**
   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```
5. **Confirm the backend is running** on the port you proxy to (e.g. `curl -X POST http://127.0.0.1:8087/api/auth/login -H "Content-Type: application/json" -d '{"email":"x@y.com","password":"z"}'` should return 401 Unauthorized, not 405).

**If your frontend is served from disk** (e.g. `root /var/www/twynbook; try_files $uri /index.html;`), add a **new** block that sends only `/api/` to the backend; keep your existing `location /` for the SPA. Example:

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:8087;   # or your FastAPI backend address
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 25M;
    proxy_connect_timeout 600s;
    proxy_send_timeout 600s;
    proxy_read_timeout 600s;
}

location / {
    root /var/www/twynbook;   # your existing SPA root
    try_files $uri $uri/ /index.html;
}
```

## 413 Request Entity Too Large

When creating a persona (selfie + voice recording), the request can exceed Nginx’s default body limit (1MB), causing **413 Request Entity Too Large**.

## 504 Gateway Time-out

Persona creation waits for Ditto to generate a 60-second idle video, which can take several minutes. Nginx’s default proxy timeout (often 60s) cuts the request off → **504 Gateway Time-out**.

## Fix on the server

On the machine where Nginx runs (e.g. `twynbook.4th-ir.com`):

1. **Edit the Nginx config** for this site (e.g. `/etc/nginx/sites-available/default` or `twynbook`).

2. **Inside the `server { ... }` block** that proxies to TwynBook, add (or merge with existing directives):
   ```nginx
   client_max_body_size 25M;
   proxy_connect_timeout 600s;
   proxy_send_timeout 600s;
   proxy_read_timeout 600s;
   ```
   Use **two location blocks**: `location /api/` first (so all API methods work), then `location /`. Example:
   ```nginx
   server {
       server_name twynbook.4th-ir.com;
       client_max_body_size 25M;

       location /api/ {
           proxy_pass http://127.0.0.1:8087;
           proxy_http_version 1.1;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
           proxy_connect_timeout 600s;
           proxy_send_timeout 600s;
           proxy_read_timeout 600s;
       }

       location / {
           proxy_pass http://127.0.0.1:8087;
           proxy_http_version 1.1;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
           proxy_connect_timeout 600s;
           proxy_send_timeout 600s;
           proxy_read_timeout 600s;
       }
   }
   ```

3. **Test and reload Nginx:**
   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```

After this, persona creation should complete without 413 or 504.
