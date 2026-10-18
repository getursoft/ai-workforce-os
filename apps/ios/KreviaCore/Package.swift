// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "KreviaCore",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "KreviaCore", targets: ["KreviaCore"])
    ],
    targets: [
        .target(name: "KreviaCore", path: "Sources/KreviaCore"),
        .testTarget(name: "KreviaCoreTests", dependencies: ["KreviaCore"], path: "Tests/KreviaCoreTests")
    ]
)
