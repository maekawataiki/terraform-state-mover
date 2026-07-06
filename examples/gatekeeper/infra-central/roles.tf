resource "aws_iam_role" "eks_cluster_role" {
  name               = "eks-cluster-role"
  assume_role_policy = "{}"
}

resource "aws_iam_role" "events_processor_role" {
  name               = "events-processor-role"
  assume_role_policy = "{}"
}
