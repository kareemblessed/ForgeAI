import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    rolldownOptions: {
      output: {
        // Separate long-lived vendor code from app code so redeploys only
        // invalidate the (small) app chunk, and the browser fetches them in parallel.
        codeSplitting: {
          groups: [
            { name: 'vendor-react',    test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: 'vendor-supabase', test: /node_modules[\\/]@supabase[\\/]/ },
            { name: 'vendor-genai',    test: /node_modules[\\/]@google[\\/]genai[\\/]/ },
          ],
        },
      },
    },
  },
  server: { port: 3000 },
  envDir: '.', // explicitly tell Vite to look in the project root
});
