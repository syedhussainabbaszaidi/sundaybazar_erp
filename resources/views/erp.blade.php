<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#10291f">
<title>SundayBazar ERP</title>
@include('partials.icons')
<link rel="preload" href="{{ asset('erp/fonts/poppins-latin-400.woff2') }}" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="{{ asset('erp/fonts/poppins-latin-600.woff2') }}" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="{{ asset('erp/app.css') }}?v={{ $v }}">
</head>
<body>
<a class="sr-only" href="#main">Skip to content</a>
<div id="root"><div style="min-height:100vh;display:grid;place-items:center;background:#10291f"><img src="{{ asset('sundaybazarlogo.png') }}" alt="Sunday Bazar" width="140" height="103" style="opacity:.92"></div></div>
<script src="{{ asset('erp/pre.js') }}?v={{ $v }}"></script>
<script src="{{ asset('erp/app.js') }}?v={{ $v }}"></script>
<script src="{{ asset('erp/shopify.js') }}?v={{ $v }}"></script>
<script src="{{ asset('erp/access.js') }}?v={{ $v }}"></script>
<script src="{{ asset('erp/post.js') }}?v={{ $v }}"></script>
</body>
</html>
