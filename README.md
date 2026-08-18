# Veelord Collection & Gift Store

A luxury black-and-gold e-commerce storefront with:
- Product catalogue
- Mobile-friendly design
- Admin login/dashboard
- Add/edit/delete products
- Product image uploads
- Naira pricing
- One-click WhatsApp ordering

## Run it
1. Install Node.js 20+.
2. Copy `.env.example` to `.env` and change the admin password + session secret.
3. Run `npm install`
4. Run `npm start`
5. Open `http://localhost:3000`
6. Admin: `http://localhost:3000/admin/login`

Starter product images are included from the images supplied in the chat.

## Important
This starter uses SQLite and local image storage. It is suitable for a VPS or a host with persistent storage. For a zero-maintenance cloud deployment, the next step is to connect the app to a managed database/object-storage service.