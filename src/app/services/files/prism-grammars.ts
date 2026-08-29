import Prism from 'prismjs';

// Grammaires embarquées (l'ordre compte : c avant cpp, markup-templating
// avant php, typescript/jsx avant tsx). Ce module est la cible d'un import
// DYNAMIQUE : Prism et ses 24 grammaires forment un chunk paresseux, chargé
// à la première coloration et plus jamais au démarrage de l'app.
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-toml';
import 'prismjs/components/prism-ini';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-ruby';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-markup-templating';
import 'prismjs/components/prism-php';
import 'prismjs/components/prism-scss';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-docker';
import 'prismjs/components/prism-nginx';
import 'prismjs/components/prism-makefile';
import 'prismjs/components/prism-diff';

// Pas de scan automatique du DOM au chargement.
Prism.manual = true;

export default Prism;
