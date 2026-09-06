using System.Collections.Immutable;
using System.Reflection;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Text.Json.Serialization;
using System.Xml.Linq;

namespace InspectorGadget.Dotnet;

// NDepend-style .NET analyzer (BCL-only, System.Reflection.Metadata): context =
// assembly, namespace = C# namespace, leaf = type, edge = type→type (structural
// metadata + decoded method-body IL). First-party from .csproj+bin; every other
// referenced assembly (incl. System.*/Microsoft.*) is third-party.
//
// Returns RAW shape (RawDto) to be serialized to stdout JSON. The node
// orchestrator merges this with any TS-side raw output and runs the shared
// model.assemble() to finalize. Build the target first (`dotnet build`).
//
// Sibling of analyze-ts.mjs; the two analyzers produce the same wire shape.
//
// FAILURE CHANNEL: every catch here records a {stage,subject,reason} skip or
// throws. A metadata walk over third-party binaries meets malformed input as a
// matter of course, so tolerance is correct — silence about it is not.
internal static class Analyzer
{
    public static readonly string[] DefaultExcludes = { "bin", "obj", "node_modules" };

    private const string NsSep = " · "; // keep in sync with model.mjs / dsm.client.js wire

    private readonly record struct TypeId(string Assembly, string FullName);
    private readonly record struct TypeLoc(int ReaderIdx, TypeDefinitionHandle Handle);

    // reason is the exception TYPE NAME, never e.Message: messages carry absolute
    // paths and culture-dependent prose, and the artifact must diff cleanly.
    private static string Reason(Exception e) => e.GetType().Name;

    // subject for a filesystem site: root-relative with forward slashes. An
    // absolute path would put the machine and the checkout location in the artifact.
    private static string Rel(string root, string p) => Path.GetRelativePath(root, p).Replace('\\', '/');

    private sealed class SkipLog
    {
        private readonly HashSet<(string, string, string)> _seen = new();
        private readonly List<SkipDto> _items = new();
        public void Add(string stage, string subject, string reason)
        {
            if (_seen.Add((stage, subject, reason)))
                _items.Add(new SkipDto { Stage = stage, Subject = subject, Reason = reason });
        }
        public List<SkipDto> Sorted() => _items
            .OrderBy(s => s.Stage, StringComparer.Ordinal)
            .ThenBy(s => s.Subject, StringComparer.Ordinal)
            .ThenBy(s => s.Reason, StringComparer.Ordinal)
            .ToList();
    }

    // carries the log plus the leaf whose edges are being collected, so a loss
    // deep in the IL walk names the type it came from
    private readonly record struct Sink(SkipLog Log, string Subject);

    public static RawDto Build(string root, string[] excludes)
    {
        var exclude = new HashSet<string>(excludes, StringComparer.Ordinal);
        var log = new SkipLog();

        var csprojs = new List<string>();
        FindCsproj(root, exclude, csprojs, log, root);
        csprojs.Sort(StringComparer.Ordinal);

        var firstPartyDlls = new List<(string asm, string dll)>();
        var asmSeen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var cs in csprojs)
        {
            string asm = AsmName(cs, log, Rel(root, cs));
            string? dll = FindDll(Path.GetDirectoryName(cs)!, asm, log);
            if (dll == null) continue;
            if (asmSeen.Add(asm)) firstPartyDlls.Add((asm, dll));
        }
        if (firstPartyDlls.Count == 0)
            throw new Exception($"no built assemblies found under {root} ({csprojs.Count} .csproj discovered) — build the target first (e.g. `dotnet build`)");

        var streams = new List<FileStream>();
        var pes = new List<PEReader>();
        var readers = new List<MetadataReader>();
        var ctxNames = new List<string>();
        try
        {
            var files = new List<string>();
            var fileCtx = new Dictionary<string, string>(StringComparer.Ordinal);
            var fileNs = new Dictionary<string, string>(StringComparer.Ordinal);
            var index = new Dictionary<TypeId, string>();
            var typeOf = new Dictionary<string, TypeLoc>(StringComparer.Ordinal);
            var firstParty = new HashSet<string>(StringComparer.Ordinal);

            foreach (var (asm, dll) in firstPartyDlls)
            {
                FileStream? fsOpen = null;
                FileStream fs; PEReader pe; MetadataReader r;
                try
                {
                    fs = fsOpen = new FileStream(dll, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                    pe = new PEReader(fs);
                    r = pe.GetMetadataReader();
                }
                catch (Exception e)
                {
                    // the whole assembly is lost: it vanishes as a context AND is
                    // reclassified third-party by every reference to it
                    log.Add("dotnet.assembly", asm, Reason(e));
                    fsOpen?.Dispose();
                    continue;
                }

                string ctx;
                try { ctx = r.GetString(r.GetAssemblyDefinition().Name); }
                catch (Exception e) { log.Add("dotnet.assembly-name", asm, Reason(e)); ctx = asm; }
                if (string.IsNullOrEmpty(ctx)) ctx = asm;

                streams.Add(fs); pes.Add(pe); readers.Add(r); ctxNames.Add(ctx);
                int myIdx = readers.Count - 1;
                firstParty.Add(ctx);

                foreach (var th in r.TypeDefinitions)
                {
                    var td = r.GetTypeDefinition(th);
                    string name = r.GetString(td.Name);
                    if (name.Length == 0 || name.IndexOf('<') >= 0) continue;
                    var (ns, full) = TypeName(r, th);
                    if (full.IndexOf('<') >= 0) continue;
                    string nsLabel = ns.Length > 0 ? ns : "(root)";
                    string typeLocal = ns.Length > 0 && full.StartsWith(ns + ".", StringComparison.Ordinal)
                        ? full[(ns.Length + 1)..] : full;
                    string leaf = ctx + "/" + nsLabel + "/" + typeLocal;
                    if (typeOf.ContainsKey(leaf)) continue;
                    files.Add(leaf);
                    fileCtx[leaf] = ctx;
                    fileNs[leaf] = ctx + NsSep + nsLabel;
                    index[new TypeId(ctx, full)] = leaf;
                    typeOf[leaf] = new TypeLoc(myIdx, th);
                }
            }
            files.Sort(StringComparer.Ordinal);

            // pass 2: type→type edges (structural + IL bodies)
            var edges = new List<string[]>();
            var edgeSeen = new HashSet<(string, string)>();
            var tpEdges = new List<string[]>();
            var tpSeen = new HashSet<(string, string)>();
            var tpPkgs = new HashSet<string>(StringComparer.Ordinal);

            foreach (var leaf in files)
            {
                var (readerIdx, typeHandle) = typeOf[leaf];
                var reader = readers[readerIdx]; var peReader = pes[readerIdx]; var ctx = ctxNames[readerIdx];
                var ids = new List<TypeId>();
                var idSeen = new HashSet<TypeId>();
                var sink = new Sink(log, leaf);
                try { CollectTypeRefs(reader, peReader, ctx, typeHandle, ids, idSeen, sink); }
                catch (Exception e) { log.Add("dotnet.type", leaf, Reason(e)); }

                foreach (var id in ids)
                {
                    if (index.TryGetValue(id, out var tleaf))
                    {
                        var key = (leaf, tleaf);
                        if (tleaf != leaf && edgeSeen.Add(key)) edges.Add(new[] { leaf, tleaf });
                    }
                    else if (!firstParty.Contains(id.Assembly))
                    {
                        tpPkgs.Add(id.Assembly);
                        var key = (leaf, id.Assembly);
                        if (tpSeen.Add(key)) tpEdges.Add(new[] { leaf, id.Assembly });
                    }
                }
            }

            return new RawDto
            {
                Files = files,
                FileCtx = fileCtx,
                FileNs = fileNs,
                Edges = edges,
                TpEdges = tpEdges,
                TpPkgs = tpPkgs.OrderBy(x => x, StringComparer.Ordinal).ToList(),
                TypeXctxEdges = new List<string[]>(), // none for dotnet
                Skips = log.Sorted(),
            };
        }
        finally
        {
            foreach (var pe in pes) pe.Dispose();
            foreach (var fs in streams) fs.Dispose();
        }
    }

    private static void FindCsproj(string dir, HashSet<string> exclude, List<string> outp, SkipLog log, string root)
    {
        string[] entries;
        try { entries = Directory.GetFileSystemEntries(dir); }
        catch (Exception e) { log.Add("dotnet.scandir", Rel(root, dir), Reason(e)); return; }
        foreach (var p in entries)
        {
            string name = Path.GetFileName(p);
            if (Directory.Exists(p))
            {
                if (name.StartsWith('.') || exclude.Contains(name)) continue;
                FindCsproj(p, exclude, outp, log, root);
            }
            else if (name.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase))
            {
                outp.Add(p);
            }
        }
    }

    // the filename fallback is a GUESS, and a guessed assembly name is what
    // FindDll then looks for — so an unreadable project is recorded, not assumed away
    private static string AsmName(string csproj, SkipLog log, string subject)
    {
        try
        {
            var doc = XDocument.Load(csproj);
            var an = doc.Descendants().FirstOrDefault(e => e.Name.LocalName == "AssemblyName")?.Value;
            if (!string.IsNullOrWhiteSpace(an) && !an.Contains('$')) return an.Trim();
        }
        catch (Exception e) { log.Add("dotnet.csproj", subject, Reason(e)); }
        return Path.GetFileNameWithoutExtension(csproj);
    }

    // three-way, so one lost project yields exactly one record and names WHICH
    // of the three losses it was: never built · bin unreadable · nothing matched
    private static string? FindDll(string projDir, string asm, SkipLog log)
    {
        string bin = Path.Combine(projDir, "bin");
        if (!Directory.Exists(bin)) { log.Add("dotnet.unbuilt", asm, "NOBIN"); return null; }
        string[] cands;
        try { cands = Directory.GetFiles(bin, asm + ".dll", SearchOption.AllDirectories); }
        catch (Exception e) { log.Add("dotnet.bin", asm, Reason(e)); return null; }
        var hit = cands
            .Where(p => { var u = p.Replace('\\', '/'); return !u.Contains("/ref/") && !u.Contains("/refint/"); })
            .OrderByDescending(File.GetLastWriteTimeUtc)
            .FirstOrDefault();
        if (hit == null) log.Add("dotnet.unbuilt", asm, "NOCANDIDATE");
        return hit;
    }

    private static (string ns, string full) TypeName(MetadataReader r, TypeDefinitionHandle h)
    {
        var td = r.GetTypeDefinition(h);
        string name = r.GetString(td.Name);
        var decl = td.GetDeclaringType();
        if (decl.IsNil)
        {
            string ns = r.GetString(td.Namespace);
            return (ns, ns.Length > 0 ? ns + "." + name : name);
        }
        var (pns, pfull) = TypeName(r, decl);
        return (pns, pfull + "+" + name);
    }

    private static TypeId ResolveTypeRef(MetadataReader r, string ctx, TypeReferenceHandle h)
    {
        var tr = r.GetTypeReference(h);
        string name = r.GetString(tr.Name);
        var scope = tr.ResolutionScope;
        if (scope.Kind == HandleKind.AssemblyReference)
        {
            string asm = r.GetString(r.GetAssemblyReference((AssemblyReferenceHandle)scope).Name);
            string ns = r.GetString(tr.Namespace);
            return new TypeId(asm, ns.Length > 0 ? ns + "." + name : name);
        }
        if (scope.Kind == HandleKind.TypeReference)
        {
            var (pasm, pfull) = ResolveTypeRef(r, ctx, (TypeReferenceHandle)scope);
            return new TypeId(pasm, pfull + "+" + name);
        }
        {
            string ns = r.GetString(tr.Namespace);
            return new TypeId(ctx, ns.Length > 0 ? ns + "." + name : name);
        }
    }

    private static void CollectTypeRefs(MetadataReader r, PEReader pe, string ctx,
        TypeDefinitionHandle th, List<TypeId> ids, HashSet<TypeId> seen, in Sink sink)
    {
        var td = r.GetTypeDefinition(th);
        var sk = sink;
        void Add(EntityHandle e) { if (!e.IsNil) Resolve(r, ctx, e, ids, seen, sk); }

        if (!td.BaseType.IsNil) Add(td.BaseType);
        foreach (var ih in td.GetInterfaceImplementations()) Add(r.GetInterfaceImplementation(ih).Interface);
        AddGenericConstraints(r, ctx, td.GetGenericParameters(), ids, seen, sink);
        foreach (var ca in td.GetCustomAttributes()) Add(r.GetCustomAttribute(ca).Constructor);

        foreach (var fhh in td.GetFields())
        {
            var fd = r.GetFieldDefinition(fhh);
            DecodeInto(ids, seen, r, ctx, c => fd.DecodeSignature(c, null), sink);
            foreach (var ca in fd.GetCustomAttributes()) Add(r.GetCustomAttribute(ca).Constructor);
        }
        foreach (var ph in td.GetProperties())
        {
            var pd = r.GetPropertyDefinition(ph);
            DecodeInto(ids, seen, r, ctx, c => pd.DecodeSignature(c, null), sink);
        }
        foreach (var mh in td.GetMethods())
        {
            var md = r.GetMethodDefinition(mh);
            DecodeInto(ids, seen, r, ctx, c => md.DecodeSignature(c, null), sink);
            AddGenericConstraints(r, ctx, md.GetGenericParameters(), ids, seen, sink);
            foreach (var ca in md.GetCustomAttributes()) Add(r.GetCustomAttribute(ca).Constructor);

            if (md.RelativeVirtualAddress != 0)
            {
                try
                {
                    var body = pe.GetMethodBody(md.RelativeVirtualAddress);
                    if (!body.LocalSignature.IsNil)
                        DecodeInto(ids, seen, r, ctx, c => r.GetStandaloneSignature(body.LocalSignature).DecodeLocalSignature(c, null), sink);
                    foreach (var er in body.ExceptionRegions)
                        if (er.Kind == ExceptionRegionKind.Catch && !er.CatchType.IsNil) Add(er.CatchType);
                    var il = body.GetILBytes();
                    if (il != null) WalkIL(il, r, ctx, ids, seen, sink);
                }
                catch (Exception e) { sink.Log.Add("dotnet.methodbody", sink.Subject, Reason(e)); }
            }
        }
    }

    private static void AddGenericConstraints(MetadataReader r, string ctx,
        GenericParameterHandleCollection gps, List<TypeId> ids, HashSet<TypeId> seen, in Sink sink)
    {
        foreach (var gph in gps)
        {
            var gp = r.GetGenericParameter(gph);
            foreach (var ch in gp.GetConstraints())
            {
                var t = r.GetGenericParameterConstraint(ch).Type;
                if (!t.IsNil) Resolve(r, ctx, t, ids, seen, sink);
            }
        }
    }

    private static void DecodeInto(List<TypeId> ids, HashSet<TypeId> seen,
        MetadataReader r, string ctx, Action<RefCollector> decode, in Sink sink)
    {
        var col = new RefCollector();
        try { decode(col); }
        catch (Exception e) { sink.Log.Add("dotnet.signature", sink.Subject, Reason(e)); return; }
        foreach (var h in col.Handles) Resolve(r, ctx, h, ids, seen, sink);
    }

    private static void Resolve(MetadataReader r, string ctx, EntityHandle h,
        List<TypeId> ids, HashSet<TypeId> seen, in Sink sink)
    {
        if (h.IsNil) return;
        switch (h.Kind)
        {
            case HandleKind.TypeDefinition:
            {
                var (_, full) = TypeName(r, (TypeDefinitionHandle)h);
                AddId(ctx, full, ids, seen);
                break;
            }
            case HandleKind.TypeReference:
            {
                var (asm, full) = ResolveTypeRef(r, ctx, (TypeReferenceHandle)h);
                AddId(asm, full, ids, seen);
                break;
            }
            case HandleKind.TypeSpecification:
            {
                var col = new RefCollector();
                try { r.GetTypeSpecification((TypeSpecificationHandle)h).DecodeSignature(col, null); }
                catch (Exception e) { sink.Log.Add("dotnet.signature", sink.Subject, Reason(e)); break; }
                foreach (var hh in col.Handles) Resolve(r, ctx, hh, ids, seen, sink);
                break;
            }
            case HandleKind.MemberReference:
                Resolve(r, ctx, r.GetMemberReference((MemberReferenceHandle)h).Parent, ids, seen, sink);
                break;
            case HandleKind.MethodDefinition:
                Resolve(r, ctx, r.GetMethodDefinition((MethodDefinitionHandle)h).GetDeclaringType(), ids, seen, sink);
                break;
            case HandleKind.FieldDefinition:
                Resolve(r, ctx, r.GetFieldDefinition((FieldDefinitionHandle)h).GetDeclaringType(), ids, seen, sink);
                break;
            case HandleKind.MethodSpecification:
            {
                var ms = r.GetMethodSpecification((MethodSpecificationHandle)h);
                Resolve(r, ctx, ms.Method, ids, seen, sink);
                var col = new RefCollector();
                try { ms.DecodeSignature(col, null); }
                catch (Exception e) { sink.Log.Add("dotnet.signature", sink.Subject, Reason(e)); break; }
                foreach (var hh in col.Handles) Resolve(r, ctx, hh, ids, seen, sink);
                break;
            }
            case HandleKind.StandaloneSignature:
            {
                var col = new RefCollector();
                try { r.GetStandaloneSignature((StandaloneSignatureHandle)h).DecodeMethodSignature(col, null); }
                catch (Exception e) { sink.Log.Add("dotnet.signature", sink.Subject, Reason(e)); break; }
                foreach (var hh in col.Handles) Resolve(r, ctx, hh, ids, seen, sink);
                break;
            }
        }
    }

    private static void AddId(string asm, string full, List<TypeId> ids, HashSet<TypeId> seen)
    {
        var id = new TypeId(asm, full);
        if (seen.Add(id)) ids.Add(id);
    }

    private static readonly Dictionary<short, OperandType> OpTable = BuildOpTable();

    private static Dictionary<short, OperandType> BuildOpTable()
    {
        var d = new Dictionary<short, OperandType>();
        foreach (var f in typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static))
        {
            if (f.FieldType == typeof(OpCode))
            {
                var oc = (OpCode)f.GetValue(null)!;
                d[oc.Value] = oc.OperandType;
            }
        }
        return d;
    }

    private static void WalkIL(byte[] il, MetadataReader r, string ctx,
        List<TypeId> ids, HashSet<TypeId> seen, in Sink sink)
    {
        int i = 0, n = il.Length;
        while (i < n)
        {
            short op;
            byte b = il[i++];
            if (b == 0xFE) { if (i >= n) break; op = unchecked((short)(0xFE00 | il[i++])); }
            else op = b;
            if (!OpTable.TryGetValue(op, out var ot)) break;

            switch (ot)
            {
                case OperandType.InlineNone: break;
                case OperandType.ShortInlineBrTarget:
                case OperandType.ShortInlineI:
                case OperandType.ShortInlineVar: i += 1; break;
                case OperandType.InlineVar: i += 2; break;
                case OperandType.ShortInlineR:
                case OperandType.InlineBrTarget:
                case OperandType.InlineI: i += 4; break;
                case OperandType.InlineI8:
                case OperandType.InlineR: i += 8; break;
                case OperandType.InlineString: i += 4; break;
                case OperandType.InlineField:
                case OperandType.InlineMethod:
                case OperandType.InlineType:
                case OperandType.InlineTok:
                case OperandType.InlineSig:
                {
                    if (i + 4 > n) return;
                    int tok = il[i] | (il[i + 1] << 8) | (il[i + 2] << 16) | (il[i + 3] << 24);
                    i += 4;
                    if (tok != 0)
                    {
                        try { Resolve(r, ctx, MetadataTokens.EntityHandle(tok), ids, seen, sink); }
                        catch (Exception e) { sink.Log.Add("dotnet.iltoken", sink.Subject, Reason(e)); }
                    }
                    break;
                }
                case OperandType.InlineSwitch:
                {
                    if (i + 4 > n) return;
                    int cnt = il[i] | (il[i + 1] << 8) | (il[i + 2] << 16) | (il[i + 3] << 24);
                    i += 4 + 4 * cnt;
                    break;
                }
                default: return;
            }
        }
    }

    private sealed class RefCollector : ISignatureTypeProvider<int, object?>
    {
        public readonly List<EntityHandle> Handles = new();
        public int GetTypeFromDefinition(MetadataReader reader, TypeDefinitionHandle handle, byte rawTypeKind) { Handles.Add(handle); return 0; }
        public int GetTypeFromReference(MetadataReader reader, TypeReferenceHandle handle, byte rawTypeKind) { Handles.Add(handle); return 0; }
        public int GetTypeFromSpecification(MetadataReader reader, object? genericContext, TypeSpecificationHandle handle, byte rawTypeKind) { Handles.Add(handle); return 0; }
        public int GetPrimitiveType(PrimitiveTypeCode typeCode) => 0;
        public int GetSZArrayType(int elementType) => 0;
        public int GetArrayType(int elementType, ArrayShape shape) => 0;
        public int GetByReferenceType(int elementType) => 0;
        public int GetPointerType(int elementType) => 0;
        public int GetGenericInstantiation(int genericType, ImmutableArray<int> typeArguments) => 0;
        public int GetGenericMethodParameter(object? genericContext, int index) => 0;
        public int GetGenericTypeParameter(object? genericContext, int index) => 0;
        public int GetFunctionPointerType(MethodSignature<int> signature) => 0;
        public int GetModifiedType(int modifier, int unmodifiedType, bool isRequired) => 0;
        public int GetPinnedType(int elementType) => 0;
    }
}

// One distinct subject lost or degraded during a run. reason is a stable
// classifier (an exception type name or a sentinel), never a message.
internal sealed class SkipDto
{
    [JsonPropertyName("stage")]   public required string Stage { get; set; }
    [JsonPropertyName("subject")] public required string Subject { get; set; }
    [JsonPropertyName("reason")]  public required string Reason { get; set; }
}

// Wire shape matching analyze-ts.mjs's return value. JSON property names = the
// JS keys the orchestrator (index.mjs / mergeRaw) reads.
internal sealed class RawDto
{
    [JsonPropertyName("files")]         public required List<string> Files { get; set; }
    [JsonPropertyName("fileCtx")]       public required Dictionary<string, string> FileCtx { get; set; }
    [JsonPropertyName("fileNs")]        public required Dictionary<string, string> FileNs { get; set; }
    [JsonPropertyName("edges")]         public required List<string[]> Edges { get; set; }
    [JsonPropertyName("tpEdges")]       public required List<string[]> TpEdges { get; set; }
    [JsonPropertyName("tpPkgs")]        public required List<string> TpPkgs { get; set; }
    [JsonPropertyName("typeXctxEdges")] public required List<string[]> TypeXctxEdges { get; set; }
    [JsonPropertyName("skips")]         public required List<SkipDto> Skips { get; set; }
}
