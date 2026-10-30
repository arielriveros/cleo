// The QEM decimator moved to @cleo/app-kit so the Creator's Foliage mode can build LODs with it too.
// Re-exported here so the editor's call sites (projectJobs, lodGenerate, the tests) keep their path.
export * from '@cleo/app-kit/geometry/simplify'
