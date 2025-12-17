import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // Charge les variables d'environnement (locales .env ou système CI/CD)
  // process.env n'est pas disponible par défaut dans le code client compilé par Vite.
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react()],
    // 'define' remplace globalement le texte dans le code source lors du build.
    // C'est ici qu'on fait le pont entre GitHub Secrets (process.env) et le code React.
    define: {
      'process.env.API_KEY': JSON.stringify(env.VITE_API_KEY || process.env.VITE_API_KEY)
    },
    build: {
      outDir: 'dist',
      sourcemap: false
    }
  };
});